'use strict';
/* ==================================================================
 * GeoFS-LiverySelector 3.6.3 修复版 (3.6.3-fixed)
 * ------------------------------------------------------------------
 * 故障根因与修复：
 * 1) 原脚本用 raw.githubusercontent.com 取 commit.txt，失败后把数据源整体
 *    切回 raw；而国内 raw 会被重置，导致 commit.txt / livery.json /
 *    whitelist.json 全部拉取失败。=> 改为多镜像探测，兜底也不会指向 raw。
 * 2) livery.json 没加载成功时 liveryobj.aircrafts 为 undefined，
 *    所有 Object.keys(liveryobj.aircrafts) 与下标访问都会抛错
 *    (Cannot convert undefined or null to object / Cannot read '737_700')。
 *    => 所有消费点统一加空值守卫，数据没到位就安静跳过。
 * 3) localStorage.links 里的非法 / 相对条目会被当成站点自身路径，产生
 *    https://beta.geo-fs.com/xxx 的 404 请求，404 页面又让 res.json()
 *    抛 "Unexpected token '<' ... not valid JSON"。=> 入库前校验绝对 URL。
 * 4) 修复 scheduleMultiplayerUpdate() 被调用两次造成的报错翻倍、
 *    以及 generatePanelButtonHTML() 尾部的残留字符。
 * 5) 【换装提速】原脚本换涂装时，GeoFS 会现场去 livery.json 里写死的
 *    cdn.jsdelivr.net / raw.githubusercontent.com 下载贴图；这两个源国内
 *    要么多一跳(301)、要么直接连不上，于是每次点涂装都要等很久。
 *    => 新增“涂装加速模块”：把慢源纹理统一改写为探测到的最快镜像、
 *       下载后写入 Cache Storage + 内存 objectURL 复用、并在面板列出
 *       涂装后后台低并发预热，使换装（含首次）基本秒切。
 * ================================================================== */
const REPO_SLUG = 'kolos26/GEOFS-LiverySelector';
const GH_RAW = 'https://raw.githubusercontent.com/' + REPO_SLUG;
// 顺序即优先级；raw.githubusercontent.com 放最后兜底（国内通常不可达）
// 按国内实测速度排序：gcore / testingcf(Cloudflare 节点) 明显快于 cdn / fastly
const MIRRORS = [
    { base: 'https://gcore.jsdelivr.net/gh/' + REPO_SLUG + '@main',
      pin: c => 'https://gcore.jsdelivr.net/gh/' + REPO_SLUG + '@' + c },
    { base: 'https://testingcf.jsdelivr.net/gh/' + REPO_SLUG + '@main',
      pin: c => 'https://testingcf.jsdelivr.net/gh/' + REPO_SLUG + '@' + c },
    { base: 'https://cdn.jsdelivr.net/gh/' + REPO_SLUG + '@main',
      pin: c => 'https://cdn.jsdelivr.net/gh/' + REPO_SLUG + '@' + c },
    { base: 'https://fastly.jsdelivr.net/gh/' + REPO_SLUG + '@main',
      pin: c => 'https://fastly.jsdelivr.net/gh/' + REPO_SLUG + '@' + c },
    { base: 'https://ghfast.top/' + GH_RAW + '/main',
      pin: c => 'https://ghfast.top/' + GH_RAW + '/' + c },
    { base: GH_RAW + '/main',
      pin: c => GH_RAW + '/' + c },
];
let jsDelivr = MIRRORS[0].base;
let noCommit = MIRRORS[0].base;
const version = '3.6.3';

/* ==================================================================
 * 换装加速模块：镜像改写 + 本地纹理缓存 + 后台预热
 * ------------------------------------------------------------------
 * 换装慢的根因：livery.json 里绝大多数涂装纹理写死成了
 *   https://cdn.jsdelivr.net/gh/kolos26/GEOFS-LiverySelector@main/...
 * 以及少量 https://raw.githubusercontent.com/...，这两个域名在国内经常
 * 被限速 / 连接被重置。于是每点一次涂装，GeoFS 都要现场去慢源下载
 * 一两百 KB 的贴图（有时还要卡住重试），自然“等很久”。
 *
 * 修复思路（三层，逐层兜底）：
 *   1) 改写：把 cdn.jsdelivr.net / raw.githubusercontent.com 统一改成
 *      init() 探测出的最快镜像（gcore / testingcf ...），保留原地址兜底。
 *   2) 缓存：纹理下载一次后存进 Cache Storage，下次换装直接读本地，
 *      不再走网络（换回旧涂装基本秒切）。
 *   3) 预热：面板列出当前机型涂装后，后台低并发把贴图提前拉进缓存，
 *      这样用户真正点下去时已经是本地数据。
 * ================================================================== */

// 探测到的最快镜像源（origin），由 init() 赋值
let preferredOrigin = 'https://gcore.jsdelivr.net';
// jsDelivr 各节点，preferredOrigin 会被提到最前面
const JSDELIVR_HOSTS = ['gcore.jsdelivr.net', 'testingcf.jsdelivr.net', 'cdn.jsdelivr.net', 'fastly.jsdelivr.net'];
const JSDELIVR_HOST_RE = /^https?:\/\/(?:cdn|gcore|testingcf|fastly)\.jsdelivr\.net\//i;
const RAW_GH_RE = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i;
const TEX_CACHE_NAME = 'liveryselector-textures-v1';
const TEX_CONCURRENCY = 3;       // 后台预热并发数（越低越不挤占飞行流量）
const TEX_PRELOAD_LIMIT = 120;   // 单次最多预热多少张，避免一次拉爆带宽
const TEX_MEM_LIMIT = 400;       // 内存里最多保留多少个 objectURL，超出按插入顺序淘汰
// 内存中的 url -> objectURL 映射，命中后换装零网络
const texBlobUrls = new Map();
const texInflight = new Map();

const liveryobj = {};
const mpLiveryIds = {};
const mLiveries = {};
const origHTMLs = {};
const uploadHistory = (function () {
    try { return JSON.parse(localStorage.lsUploadHistory || '{}') || {}; }
    catch (err) { console.warn('[LiverySelector] lsUploadHistory 数据损坏，已重置', err); return {}; }
})();
const LIVERY_ID_OFFSET = 10e3;
const ML_ID_OFFSET = 1e3;
let links = [];
let airlineobjs = [];
let whitelist = [];
let mpAirlineobjs = {};
const LS_KEY = 'l';
const LOG_STYLE = "white-space:nowrap;display:inline;color:";
const log = (e, t = "log") => console[t]("%c[%cLivery%cSelector%c] %c", LOG_STYLE + "inherit;", LOG_STYLE + "#bcc3cb;", LOG_STYLE + "#3f5f8a;", LOG_STYLE + "inherit;", LOG_STYLE + "inherit;", e);

/* ------------------------ 网络与数据加载工具 ------------------------ */
/**
 * 带超时的 fetch，避免被墙的域名把脚本挂死几十秒
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeout 毫秒
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(url, init = {}, timeout = 10000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    // 默认 no-store 只针对配置类小文件；涂装纹理需要命中浏览器磁盘缓存，
    // 因此允许调用方用 init.cache 覆盖（例如 'default' / 'force-cache'）。
    return fetch(url, Object.assign({ cache: 'no-store' }, init, { signal: ctrl.signal }))
        .finally(() => clearTimeout(timer));
}

/**
 * 依次尝试各镜像，返回第一个成功的响应及其镜像定义
 * @param {string} path 形如 '/commit.txt'
 * @param {number} timeout
 * @returns {Promise<{res: Response, def: {base: string, pin: Function}}>}
 */
async function fetchFirst(path, timeout = 10000) {
    let lastErr;
    for (const def of MIRRORS) {
        try {
            const res = await fetchWithTimeout(def.base + path, {}, timeout);
            if (res.ok) return { res, def };
            lastErr = new Error('HTTP ' + res.status + ' @ ' + def.base);
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error('all mirrors failed');
}

/**
 * 数据文件统一入口：优先用已锁定 commit 的 CDN，再退回 @main 与默认镜像
 * @param {string} path
 * @param {number} timeout
 * @returns {Promise<Response>}
 */
async function fetchAsset(path, timeout = 15000) {
    const seen = new Set();
    const bases = [];
    if (jsDelivr) bases.push(jsDelivr);      // 已锁定 commit 的镜像
    for (const def of MIRRORS) bases.push(def.base); // 各镜像 @main
    if (noCommit) bases.push(noCommit);
    let lastErr;
    for (const base of bases) {
        if (!base || seen.has(base)) continue; // 去重，避免在同一个镜像上重复重试
        seen.add(base);
        try {
            const res = await fetchWithTimeout(base + path, {}, timeout);
            if (res.ok) return res;
            lastErr = new Error('HTTP ' + res.status + ' @ ' + base);
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error('asset fetch failed: ' + path);
}

/* ------------------------ 涂装纹理加速 ------------------------ */

/**
 * 按优先级返回 jsDelivr 主机列表，探测到的最快节点排第一
 * @returns {string[]}
 */
function jsdelivrHostsOrdered() {
    let first = 'gcore.jsdelivr.net';
    try { first = new URL(preferredOrigin).hostname || first; } catch (e) { /* keep default */ }
    return [first, ...JSDELIVR_HOSTS.filter(h => h !== first)];
}

/**
 * 生成一张纹理的候选地址：慢源改写为最快镜像，原始地址永远最后兜底。
 * 非 http(s) 地址（相对路径 / data: / blob:）原样返回。
 * @param {string} url
 * @returns {string[]}
 */
function textureCandidates(url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return [url];
    // jsDelivr 家族：换主机，保留路径与查询串；原主机已包含在主机列表里
    if (JSDELIVR_HOST_RE.test(url)) {
        const path = url.replace(JSDELIVR_HOST_RE, '');
        return jsdelivrHostsOrdered().map(h => 'https://' + h + '/' + path);
    }
    // raw.githubusercontent.com -> jsDelivr / ghfast 代理
    const m = url.match(RAW_GH_RE);
    if (m) {
        const repo = m[1] + '/' + m[2];
        const branch = m[3];
        const rest = m[4];
        const out = jsdelivrHostsOrdered()
            .map(h => 'https://' + h + '/gh/' + repo + '@' + branch + '/' + rest);
        out.push('https://ghfast.top/' + url);
        out.push(url); // 兜底：原始地址
        return Array.from(new Set(out));
    }
    return [url];
}

/**
 * 读取本地持久化缓存（Cache Storage）
 * @param {string} url
 * @returns {Promise<Blob|null>}
 */
async function readTextureCache(url) {
    try {
        if (typeof caches === 'undefined') return null;
        const cache = await caches.open(TEX_CACHE_NAME);
        const res = await cache.match(url);
        if (res && res.ok) return await res.blob();
    } catch (e) { /* 缓存不可用时静默降级 */ }
    return null;
}

/**
 * 写入本地持久化缓存（失败不影响主流程）
 * @param {string} url
 * @param {Blob} blob
 */
function writeTextureCache(url, blob) {
    try {
        if (typeof caches === 'undefined') return;
        caches.open(TEX_CACHE_NAME)
            .then(cache => cache.put(url, new Response(blob, {
                headers: { 'Content-Type': blob.type || 'image/webp' }
            })))
            .catch(() => { /* 配额不足等，忽略 */ });
    } catch (e) { /* 忽略 */ }
}

/**
 * 记录一个已缓存的本地地址，并在超出上限时淘汰最早的条目。
 * 淘汰时延迟释放 objectURL，避免 GeoFS 恰好还在读取它。
 * @param {string} url
 * @param {string} objUrl
 */
function rememberTexture(url, objUrl) {
    texBlobUrls.set(url, objUrl);
    while (texBlobUrls.size > TEX_MEM_LIMIT) {
        const oldestKey = texBlobUrls.keys().next().value;
        const oldestUrl = texBlobUrls.get(oldestKey);
        texBlobUrls.delete(oldestKey);
        setTimeout(() => { try { URL.revokeObjectURL(oldestUrl); } catch (e) { /* 忽略 */ } }, 60000);
    }
}

/**
 * 把一张远程纹理取到本地，返回可直接交给 GeoFS 的本地地址。
 * 顺序：内存缓存 -> 磁盘缓存 -> 多镜像下载。全部失败则退回原始地址，
 * 交由 GeoFS 自行加载（保证功能不坏）。
 * @param {string} url
 * @returns {Promise<string>}
 */
function loadTexture(url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return Promise.resolve(url); // 相对路径 / data: / blob: 原样返回
    }
    if (texBlobUrls.has(url)) return Promise.resolve(texBlobUrls.get(url));
    if (texInflight.has(url)) return texInflight.get(url);

    const task = (async () => {
        let blob = await readTextureCache(url);
        if (!blob) {
            for (const cand of textureCandidates(url)) {
                try {
                    const res = await fetchWithTimeout(cand, { cache: 'default' }, 30000);
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    blob = await res.blob();
                    break;
                } catch (err) {
                    // 试下一个候选地址
                }
            }
        }
        if (!blob) return url; // 全失败：交给 GeoFS 按原地址加载
        writeTextureCache(url, blob);
        let objUrl;
        try {
            objUrl = URL.createObjectURL(blob);
        } catch (e) {
            return url;
        }
        rememberTexture(url, objUrl);
        return objUrl;
    })();

    texInflight.set(url, task);
    return task.finally(() => {
        if (texInflight.get(url) === task) texInflight.delete(url);
    });
}

/**
 * 收集当前机型所有涂装里的远程纹理地址（去重）
 * @param {object} airplane
 * @returns {string[]}
 */
function collectLiveryTextures(airplane) {
    const set = new Set();
    if (!airplane || !Array.isArray(airplane.liveries)) return [];
    for (const livery of airplane.liveries) {
        if (!livery || !Array.isArray(livery.texture)) continue;
        for (const t of livery.texture) {
            if (typeof t === 'string' && /^https?:\/\//i.test(t)) set.add(t);
        }
    }
    return Array.from(set);
}

/**
 * 后台预热当前机型的涂装纹理，让首次点击也尽量命中本地缓存。
 * 低并发 + 小间隔，尽量不打扰正在进行的飞行。
 * @param {object} airplane
 */
function preloadLiveryTextures(airplane) {
    try {
        if (localStorage.liveryNoPreload === '1') return; // 用户主动关闭预热
        if (typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData) return;
        const urls = collectLiveryTextures(airplane).slice(0, TEX_PRELOAD_LIMIT);
        if (!urls.length) return;
        log(`后台预热 ${urls.length} 张涂装纹理（可设置 localStorage.liveryNoPreload='1' 关闭）`);
        let cursor = 0;
        const worker = async () => {
            while (cursor < urls.length) {
                const url = urls[cursor++];
                try { await loadTexture(url); } catch (e) { /* 单张失败忽略 */ }
                await new Promise(r => setTimeout(r, 120)); // 节流，别抢飞行带宽
            }
        };
        for (let i = 0; i < Math.min(TEX_CONCURRENCY, urls.length); i++) worker();
    } catch (e) {
        log('涂装预热异常（已忽略）：' + e.message, 'warn');
    }
}

(async function init() {
    // 先探测可用镜像并锁定 commit；失败也不会把数据源退回被墙的 raw
    try {
        const { res, def } = await fetchFirst('/commit.txt');
        const commit = (await res.text()).trim();
        noCommit = def.base; // 图片等静态资源走 @main
        jsDelivr = /^[a-f0-9]{40}$/.test(commit) ? def.pin(commit) : def.base;
    } catch (err) {
        log('镜像探测失败，改用默认 CDN：' + err.message, 'warn');
        noCommit = MIRRORS[0].base;
        jsDelivr = MIRRORS[0].base;
    }
    // 记录探测到的最快镜像源：涂装纹理会统一改写到这里，避开国内偏慢的 cdn.jsdelivr.net
    try { preferredOrigin = new URL(noCommit).origin; } catch (e) { /* keep default */ }
    
    // styles
    fetchAsset('/styles.css').then(async data => {
        const styleTag = createTag('style', { type: 'text/css' });
        styleTag.textContent = await data.text();
        document.head.appendChild(styleTag);
    }).catch(err => log('styles.css 加载失败：' + err.message, 'warn'));

    //Load liveries (@todo: consider optimising livery.json or converting it to a different datatype)
    fetchAsset('/livery.json', 45000).then(handleLiveryJson)
        .catch(err => log('livery.json 加载失败，涂装库暂不可用：' + err.message, 'error'));
    // Panel for list
    const uiLeft = document.querySelector('.geofs-ui-left');
    if (!uiLeft) {
        log('未找到 GeoFS 界面容器 .geofs-ui-left，请在游戏加载完成后再运行本脚本。', 'error');
        return;
    }
    const listDiv = appendNewChild(uiLeft, 'div', {
        id: 'listDiv',
        class: 'geofs-list geofs-toggle-panel livery-list',
        'data-noblur': 'true',
        'data-onshow': '{geofs.initializePreferencesPanel()}', // are these properties needed?
        'data-onhide': '{geofs.savePreferencesPanel()}'
    });
    listDiv.innerHTML = generateListHTML();
    
    // one big event listener for the main livery list instead of multiple event listeners
    const livList = document.querySelector("#liverylist");
    livList.addEventListener('click', function ({ target }) {
        if (target.nodeName === "I") return void window.LiverySelector.star(target); // if the element clicked is a star, run the star function
        const clickedLi = target.closest('li');
        if (!clickedLi) return;
        const idx = parseInt(clickedLi.getAttribute('data-idx')); // convert to int because attributes are stored as strings
        if (isNaN(idx)) return; // avoid livery selection when other stuff is pressed
        const airplane = LiverySelector.liveryobj.aircrafts && LiverySelector.liveryobj.aircrafts[getACPath()];
        if (!airplane || !Array.isArray(airplane.liveries)) return;
        const livery = airplane.liveries[idx];
        if (!livery) return;
        livery.disabled || (loadLivery(livery.texture, airplane.index, airplane.parts, livery.materials),
        livery.mp != 'disabled' && setInstanceId(idx, livery.alias));
    }); // uses || (logical OR) to run the right side code only if livery.disabled is falsy
    livList.addEventListener('error', function(e) {
        const defaultThumb = `${noCommit}/thumbs/${geofs.aircraft.instance.id}.webp`;
        if (e.target.tagName !== 'IMG' || e.target.src === defaultThumb) return;
        e.target.onerror = null;
        e.target.src = defaultThumb;
    }, true);
    
    document.querySelector("#listDiv > ul#favorites").addEventListener("click", function ({ target }) {
        if (target.nodeName != "LI") return;
        const $match = $(`#liverylist > [id='${$(target).attr("id").replace("_favorite", "_button")}']`) // find the matching livery list item
        if ($match.length === 0) return void ui.notification.show(`ID: ${$(target).attr("id")} is missing a liveryList counterpart.`)
        $match.click();
    });

    const potatoCheckbox = document.querySelector("#livery-potato-mode");
    potatoCheckbox.addEventListener("change", function () {
        geofs.setPreferenceFromInput(this);
        document.querySelector(".potato-mode-search").classList.toggle("geofs-visible", this.checked);
        geofs.savePreferences();
        window.LiverySelector[this.checked ? "potatoSearch" : "search"](document.querySelector("#searchlivery").value);
    });
    window.executeOnEventDone("geofsInitialized", () => {
        potatoCheckbox.checked = geofs.preferences.liveryPotato;
        document.querySelector(".potato-mode-search").classList.toggle("geofs-visible", potatoCheckbox.checked);
    });
    document.querySelector(".potato-mode-search").addEventListener("click", function () {
        if (!geofs.preferences.liveryPotato) return;
        window.LiverySelector.potatoSearch(document.querySelector("#searchlivery").value);
    })
    // Button for panel
    const geofsUiButton = document.querySelector('.geofs-ui-bottom');
    if (geofsUiButton) {
        const insertPos = geofs.version >= 3.6 ? 4 : 3;
        geofsUiButton.insertBefore(generatePanelButtonHTML(), geofsUiButton.children[insertPos]);
    }

    //remove original buttons
    const origButtons = document.getElementsByClassName('geofs-liveries geofs-list-collapsible-item');
    Object.values(origButtons).forEach(btn => btn.parentElement.removeChild(btn));

    //Init airline databases（先过滤非法 / 相对条目，否则会被拼成站点自身的 404 请求）
    if (localStorage.getItem('links') === null) {
        localStorage.links = '';
    } else {
        const rawLinks = localStorage.links.split(',').map(s => s.trim());
        links = rawLinks.filter(isValidHttpUrl);
        if (links.join(',') !== localStorage.links) {
            localStorage.links = links.join(','); // 顺手清理被污染的脏数据
            log('已清理 localStorage.links 中 ' + (rawLinks.length - links.length) + ' 条非法条目', 'warn');
        }
        links.forEach(async function (e) {
            try {
                const res = await fetch(e);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                data.url = e;
                airlineobjs.push(data);
            } catch (err) {
                log('虚拟航空数据加载失败（已跳过 ' + e + '）：' + err.message, 'warn');
            }
        });
    }
    fetchAsset('/whitelist.json').then(res => res.json())
        .then(data => { whitelist = Array.isArray(data) ? data : []; })
        .catch(err => { whitelist = []; log('whitelist.json 加载失败：' + err.message, 'warn'); });

    // Start multiplayer
    scheduleMultiplayerUpdate();

    window.addEventListener("keyup", function (e) {
        if (e.target.classList.contains("geofs-stopKeyupPropagation")) {
            e.stopImmediatePropagation();
        }
        if (e.key === LS_KEY) {
            ui.panel.toggle(".livery-list");
            LiverySelector.togglePanel();
        }
    });
})();

/**
 * @param {Response} data
 */
async function handleLiveryJson(data) {
    const json = await data.json();
    if (!json || typeof json !== 'object') {
        log('livery.json 内容异常，已忽略。', 'error');
        return;
    }
    Object.keys(json).forEach(key => liveryobj[key] = json[key]);

    if (!liveryobj.aircrafts) {
        log('livery.json 缺少 aircrafts 字段，涂装库不可用。', 'error');
        return;
    }

    if (liveryobj.commit) jsDelivr = jsDelivr.replace("@main", "@" + liveryobj.commit)

    if (liveryobj.version != version) {
        const titleEl = document.querySelector('.livery-list h3');
        titleEl && titleEl.appendChild(
            createTag('a', {
                href: 'https://github.com/kolos26/GEOFS-LiverySelector/releases/latest',
                target: '_blank',
                style: 'display:block;width:100%;text-decoration:none;text-align:center;background-color:red;color:white;margin-top: 3px;'
            }, 'Update available: ' + liveryobj.version)
        );
    }
    // mark aircraft with livery icons
    Object.keys(liveryobj.aircrafts).forEach(ac_path => {
        let ac = liveryobj.aircrafts[ac_path];
        let aircraftId = ac.acid;
        if (!ac.logo) {
            return; //return if only the id is used by extra vehicles
        }
        const element = document.querySelector(`[data-aircraft='${aircraftId}']`);
        // save original HTML for later use (reload, aircraft change, etc..)
        if (element) {
            if (!origHTMLs[aircraftId]) {
                origHTMLs[aircraftId] = element.innerHTML;
            }

        // use orig HTML to concatenate so theres only ever one icon
        if (ac.liveries.length >= 2) {
            element.innerHTML = origHTMLs[aircraftId] +
                createTag('img', {
                    src: `${noCommit}/liveryselector-logo-small.svg`,
                    style: 'height:30px;width:auto;margin-left:20px;',
                    title: 'Liveries available'
                }).outerHTML;

                if (ac.mp != "disabled")
                    element.innerHTML += createTag('small', {
                        title: 'Liveries are multiplayer compatible\n(visible to other players)'
                    }, '🎮').outerHTML;
        }
        else {
            element.innerHTML = origHTMLs[aircraftId] +
                createTag('img', {
                    src: `${noCommit}/liveryselector-logo-small.svg`,
                    style: 'height:30px;width:auto;margin-left:20px;filter:grayscale(100%);opacity:0.5;',
                    title: 'Aircraft supported'
                }).outerHTML;
        }
        }
        });

        Object.keys(liveryobj.aircrafts).forEach(aircraftId => {
            const ac = liveryobj.aircrafts[aircraftId];
            if (!ac || !Array.isArray(ac.liveries)) return;
            if (!ac.labels) ac.labels = {}; // 兜底：个别机型缺 labels 字段时避免下游崩溃
            ac.liveries.forEach((e, t) => e.idx ||= t);
            ac.liveries.sort((e, t) => e.name.localeCompare(t.name, undefined, { sensitivity: 'base' }));
        })

    // 数据到位后，若面板已经创建，自动刷新一次列表（避免用户先点开面板是空的）
    if (document.getElementById('listDiv')) {
        try { listLiveries(); } catch (err) { log(err, 'warn'); }
    }
}

async function scheduleMultiplayerUpdate() {
    try {
        await updateMultiplayer();
    } catch (e) {
        log(e, "error");
    } finally {
        setTimeout(scheduleMultiplayerUpdate, 5000);
    }
}
// 注意：scheduleMultiplayerUpdate 已在 init() 里调用过一次，这里不能再调，
// 否则会开出两条 5 秒定时循环，报错数量直接翻倍。

/**
 * Triggers GeoFS API to load texture
 *
 * 说明：换装前会先把所有远程纹理并发取到本地缓存（见 loadTexture），
 * 因此本函数是异步的。
 *
 * @param {string[]} texture
 * @param {number[]} index
 * @param {number[]} parts
 * @param {Object[]} mats
 */
let liveryLoadToken = 0;

async function loadLivery(texture, index, parts, mats) {
    //change livery
    if (!texture || !texture.length) return;
    // 抢一个令牌：期间若用户又点了别的涂装，本次结果直接作废，避免旧贴图覆盖新贴图
    const token = ++liveryLoadToken;

    // 先把所有远程纹理并发取到本地（命中缓存则即刻返回），再统一换装，
    // 这样换装不会被单个慢源的下载逐个拖住。
    const resolved = await Promise.all(Array.prototype.map.call(texture, t =>
        (t && typeof t === 'object') ? Promise.resolve(t) : loadTexture(t)
    ));
    if (token !== liveryLoadToken) return; // 已有更新的换装请求，丢弃本次

    for (let i = 0; i < resolved.length; i++) {
        const model3d = geofs.aircraft.instance.definition.parts[parts[i]]['3dmodel'];
        const tex = resolved[i];
        // check for material definition (for untextured parts)
        if (tex && typeof tex === 'object') {
            if (tex.material !== undefined && mats) {
                const mat = mats[tex.material];
                if (mat) {
                    model3d._model.getMaterial(mat.name)
                        .setValue(Object.keys(mat)[1], new Cesium.Cartesian4(...mat[Object.keys(mat)[1]], 1.0));
                }
            }
            continue;
        }
        if (tex === undefined || tex === null || tex === '') continue;
        try {
            if (geofs.version == 2.9) {
                geofs.api.Model.prototype.changeTexture(tex, index[i], model3d);
            } else if (geofs.version >= 3.0 && geofs.version <= 3.7) {
                geofs.api.changeModelTexture(model3d._model, tex, index[i]);
            } else {
                geofs.api.changeModelTexture(model3d._model, tex, { index: index[i] });
            }
        } catch (error) {
            geofs.api.notify("Hmmm... we can't find this livery, check the console for more info.");
            console.log(error);
        }
    }
}

/**
 * Load liveries from text input fields
 */
function inputLivery() {
    const airplane = getCurrentAircraft();
    if (!airplane) return void log('涂装数据尚未加载完成。', 'warn');
    const inputFields = document.getElementsByName('textureInput');
    const texture = [];
    inputFields.forEach(e => texture.push(e.value));
    loadLivery(generateTextureList(texture, airplane.labels, airplane.defshader), airplane.index, airplane.parts);
}

/**
 * Submit livery for review
 */
function submitLivery() {
    const airplane = getCurrentAircraft();
    const textures = airplane.liveries[0].texture;
    const inputFields = document.getElementsByName('textureInput');
    const formFields = {};
    document.querySelectorAll('.livery-submit input').forEach(f => formFields[f.id.replace('livery-submit-', '')] = f);
    if (!localStorage.liveryDiscordId || localStorage.liveryDiscordId.length < 6) {
        return alert('Invalid Discord User id!');
    }
    if (formFields.liveryname.value.trim().length < 3) {
        return alert('Invalid Livery Name!');
    }
    if (!formFields['confirm-perms'].checked || !formFields['confirm-legal'].checked) {
        return alert('Confirm all checkboxes!');
    }
    const json = {
        name: formFields.liveryname.value.trim(),
        credits: formFields.credits.value.trim(),
        texture: [],
        materials: {}
    };
    if (!json.name || json.name.trim() == '') {
        return;
    }
    const hists = [];
    const embeds = [];
    let valid = true;
    inputFields.forEach((f, i) => {
        if (f.type === "text"){
            f.value = f.value.trim();
            if (f.value.match(/^https:\/\/.+/i)) {
                const hist = Object.values(uploadHistory).find(o => o.url == f.value);
                if (!hist) {
                    valid = false;
                    return alert('Only self-uploaded imgbb links work for submitting!');
                }
                if (hist.expiration > 0) {
                    valid = false;
                    return alert('Can\'t submit expiring links! DISABLE "Expire links after one hour" option and re-upload texture:\n' + Object.keys(airplane.labels)[i]);
                }
                embeds.push({
                    title: Object.keys(Object.keys(airplane.labels))[i] + ' (' + (Math.ceil(hist.size / 1024 / 10.24) / 100) + 'MB, ' + hist.width + 'x' + hist.height + ')',
                    description: f.value,
                    image: { url: f.value },
                    fields: [
                        { name: 'Timestamp', value: new Date(hist.time * 1e3), inline: true },
                        { name: 'File ID', value: hist.id, inline: true },
                    ]
                });
                hists.push(hist);
                json.texture.push(f.value);
            } else {
                json.texture.push(textures[i]);
            }
        } else if (f.type === "color"){
            json.materials[f.id] = [parseInt(f.value.substring(1, 3), 16) / 255, parseInt(f.value.substring(3, 5), 16) / 255, parseInt(f.value.substring(5, 7), 16) / 255]
        }
    });
    if (!valid) return;
    if (!embeds.length)
        return alert('Nothing to submit, upload images first!');

    const submittedCombos = getSubmittedCombos();
    const currentCombo = { texture: json.texture, materials: json.materials };
    const alreadySubmitted = submittedCombos.some(combo => combosEqual(combo, currentCombo));
    if (alreadySubmitted) {
        alert('This livery has already been submitted!');
        return;
    }

    const content = [
        `Livery upload by <@${localStorage.liveryDiscordId}>`,
        `__Plane:__ \`${getACPath()}\` ${geofs.aircraft.instance.aircraftRecord.name}`,
        `__Livery Name:__ \`${json.name}\``,
        '```json\n' + JSON.stringify(json, null, 2) + '```'
    ];

    fetch('https://livery-submit-proxy.liveryselector.workers.dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.join('\n'), embeds })
    }).then(res => {
        hists.forEach(hist => {
            hist.submitted = hist.submitted || Math.round(new Date() / 1000);
        });
        localStorage.lsUploadHistory = JSON.stringify(uploadHistory);
        submittedCombos.push({ texture: json.texture, materials: json.materials });
        saveSubmittedCombos(submittedCombos);
        alert("You're livery has been submitted. You can check the #livery-submission channel on the GeoFS LiverySelector discord server.");
    });
}

function getSubmittedCombos() {
    try {
        const raw = JSON.parse(localStorage.getItem('submittedCombos') || '[]');
        return raw.map(combo => Array.isArray(combo) ? { texture: combo, materials: {} } : combo);
    } catch (err) {
        log('Corrupt submittedCombos data, resetting.', 'warn');
        return [];
    }
}

function saveSubmittedCombos(combos) {
    localStorage.setItem('submittedCombos', JSON.stringify(combos));
}

function combosEqual(a, b) {
    if (a.texture.length !== b.texture.length) return false;
    if (!a.texture.every((url, idx) => url === b.texture[idx])) return false;

    const aKeys = Object.keys(a.materials || {});
    const bKeys = Object.keys(b.materials || {});
    if (aKeys.length !== bKeys.length) return false;

    return aKeys.every(key => {
        const aVal = a.materials[key];
        const bVal = (b.materials || {})[key];
        if (!bVal || aVal.length !== bVal.length) return false;
        return aVal.every((v, i) => v === bVal[i]);
    });
}

/**
 *  main livery list
 */
function listLiveries() {
    const airplane = getCurrentAircraft();
    if (!airplane || !Array.isArray(airplane.liveries)) {
        log('涂装数据尚未加载完成，请稍候再试。', 'warn');
        $('#liverylist').html('');
        return;
    }
    const livList = $('#liverylist').html('');
    const tempFrag = document.createDocumentFragment()
    , thumbsDir = noCommit + '/thumbs'
    , acftId = getACPath(); // chained variable declarations
    $('#listDiv').attr('data-ac', acftId); // tells us which aircraft's liveries are loaded
    for (let i = 0; i < airplane.liveries.length; i++) {
        const e = airplane.liveries[i];
        if (e.disabled) continue;
        const listItem = $('<li/>', {id: [airplane.acid, e.name, 'button'].join('_'), class: 'livery-list-item', "data-idx": i});
        listItem.append($('<span/>').text(e.name));
        listItem.toggleClass('offi', airplane.acid <= 102).toggleClass("geofs-visible", !geofs.preferences.liveryPotato); // if param2 is true, it'll add 'offi', if not, it will remove 'offi'
        airplane.acid <= 102 && listItem.append($('<img/>', {loading: 'lazy', src: [thumbsDir, airplane.acid, airplane.acid + '-' + e.idx + '.webp'].join('/')}));
        e.credits && e.credits.length && $('<small/>').text(`by ${e.credits}`).appendTo(listItem);
        $('<i/>', { id: airplane.acid + "_" + e.name, 'data-ac': acftId, 'data-name': e.name }).appendTo(listItem);
        listItem.appendTo(tempFrag);
    }
    livList.append(tempFrag);
    loadFavorites();
    loadAirlines();
    addCustomForm();
    // 列表就绪后，后台低并发把当前机型的涂装纹理预热到本地，点选时基本秒切
    preloadLiveryTextures(airplane);
}

function loadFavorites() {
    const favorites = getFavorites();
    $("#favorites").empty();
    const acPath = getACPath();
    const airplane = getCurrentAircraft();
    (favorites[acPath] || []).forEach(function (liveryName) {
        const starEl = domById(airplane.acid + "_" + liveryName);
        if (starEl) star(starEl);
    });
}

function loadAirlines() {
    const airlineListEl = domById('airlinelist');
    if (!airlineListEl) return;
    airlineListEl.innerHTML = '';
    const airplane = getCurrentAircraft();
    airlineobjs.forEach(function(airline) {
        let airlinename = appendNewChild(domById('airlinelist'), 'li', {
            style: "color:" + airline.color + ";background-color:" + airline.bgcolor + "; font-weight: bold;"
        });
        airlinename.textContent = airline.name;
        let removebtn = appendNewChild(airlinename, "button", {
            class: "mdl-button mdl-js-button mdl-button--raised mdl-button",
            style: "float: right; margin-top: 6px; background-color: #9e150b;",
        });
        removebtn.addEventListener("click", () => {LiverySelector.removeAirline(airline.url)})
        removebtn.textContent = "- Remove airline";
        if (airline.aircrafts && Object.keys(airline.aircrafts).includes(getACPath())) { // va json indexed by ac_path
            if (!Array.isArray(airline.aircrafts[getACPath()].liveries)) return;
            airline.aircrafts[getACPath()].liveries.sort((e, t) => e.name.localeCompare(t.name, undefined, { sensitivity: 'base' }))
            airline.aircrafts[getACPath()].liveries.forEach(function (e, i) {
                let listItem = appendNewChild(domById('airlinelist'), 'li', {
                    id: [geofs.aircraft.instance.id, e.name, 'button'].join('_'),
                    class: 'livery-list-item'
                });
                listItem.addEventListener("click", () => {
                    loadLivery(generateTextureList(e.texture, airplane.labels, airplane.defshader), airplane.index, airplane.parts, e.materials);
                    if (airplane.mp != 'disabled' && Array.isArray(whitelist) && whitelist.includes(airline.url.trim())) {
                        setInstanceId(i, e.alias, airline.url);
                    }
                });
                listItem.appendChild(safeCreateTag('span', { class: 'livery-name' }, e.name));
                    if (e.credits && e.credits.length) {
                        listItem.appendChild(safeCreateTag('small', {}, `by ${e.credits}`));
                    }
            });
        }
        else if (airline.aircrafts && Object.keys(airline.aircrafts).includes(geofs.aircraft.instance.id)) {
            if (!Array.isArray(airline.aircrafts[geofs.aircraft.instance.id].liveries)) return;
            airline.aircrafts[geofs.aircraft.instance.id].liveries.forEach(function (e, i) {
                let listItem = appendNewChild(domById('airlinelist'), 'li', {
                    id: [geofs.aircraft.instance.id, e.name, 'button'].join('_'),
                    class: 'livery-list-item'
                });
                listItem.addEventListener("click", () => {
                    loadLivery(generateTextureList(e.texture, airplane.labels, airplane.defshader), airplane.index, airplane.parts, e.materials);
                    if (airplane.mp != 'disabled' && Array.isArray(whitelist) && whitelist.includes(airline.url.trim())) {
                        setInstanceId(i, e.alias, airline.url);
                    }
                });
                listItem.appendChild(safeCreateTag('span', { class: 'livery-name' }, e.name));
                if (e.credits && e.credits.length) {
                    listItem.appendChild(safeCreateTag('small', {}, `by ${e.credits}`));
                }
            });
        }
    });
}

function generateTextureList(textures, labels, def){
    Object.values(labels).forEach((slots, idx) => {
        slots.forEach((index) =>{
            if (textures[idx]){
                def[index] = textures[idx];
            }
        });
    });
    return def;
}

function addCustomForm() {
    const airplane = getCurrentAircraft();
    if (!airplane || !Array.isArray(airplane.liveries) || !airplane.liveries[0]) return;
    document.querySelector('#livery-custom-tab-upload .upload-fields').innerHTML = '';
    document.querySelector('#livery-custom-tab-direct .upload-fields').innerHTML = '';
    const textures = airplane.liveries[0].texture.filter(t => typeof t !== 'object');
    const labels = Object.entries(airplane.labels);
    if (textures.length){
        labels.forEach((e) => {
            createUploadButton(e[0]);
            createDirectButton(e[0], e[1]);
        });
    }
    if (airplane.liveries[0].materials) {
        airplane.liveries[0].materials.forEach((material, key) => {
            let partlist = [];
            airplane.liveries[0].texture.forEach((e, k) => {
                if (typeof(e) === 'object'){
                    if (e.material == key){
                        partlist.push(airplane.parts[k]);
                    }
                }
            });
            createColorChooser(material.name, Object.keys(material)[1], partlist);
            createUploadColorChooser(material.name, Object.keys(material)[1], partlist);
        })
    }
    // click first tab to refresh button status
    document.querySelector('.livery-custom-tabs li').click();
}
function debounceSearch (func) {
    let timeoutId = null;
    return (text) => {
        clearTimeout(timeoutId);
        if (geofs.preferences.liveryPotato) return;
        timeoutId = setTimeout(() => {
            func(text);
        }, 250); // debounces for 250 ms
    };
}
const search = debounceSearch(text => {
    if (geofs.preferences.liveryPotato) return;
    const liveries = document.getElementById('liverylist').children; // .children is better than .childNodes
    if (text == '') {
        log("Potato mode: " + geofs.preferences.liveryPotato);
        for (const a of liveries) a.classList.toggle('geofs-visible', !geofs.preferences.liveryPotato);
        return;
    }
    console.log(text);
    text = text.toLowerCase(); // query string lowered here to avoid repeated calls
    for (let i = 0; i < liveries.length; i++) {
        const e = liveries[i]
        , v = e.classList.contains('geofs-visible')
        if (e.textContent.toLowerCase().includes(text)) { // textContent better than innerText
            if (!v) e.classList.add('geofs-visible');
        } else {
            if (v) e.classList.remove('geofs-visible');
        }
    };
});

function potatoSearch(text) {
    const liveries = document.getElementById('liverylist').children;
    if (text == '') {
        for (const a of liveries) a.classList.toggle('geofs-visible', false);
        return;
    }
    text = text.toLowerCase();
    for (let i = 0; i < liveries.length; i++) {
        const e = liveries[i]
        , v = e.classList.contains('geofs-visible');
        e.textContent.toLowerCase().includes(text) ? (v || e.classList.add('geofs-visible')) : (v && e.classList.remove('geofs-visible'));
    };
}

function changeMaterial(name, color, type, partlist){
    let r = parseInt(color.substring(1, 3), 16) / 255
    let g = parseInt(color.substring(3, 5), 16) / 255
    let b = parseInt(color.substring(5, 7), 16) / 255
    partlist.forEach(part => {
        geofs.aircraft.instance.definition.parts[part]['3dmodel']._model.getMaterial(name).setValue(type, new Cesium.Cartesian4(r, g, b, 1.0));
    });
}

function getFavorites() {
    try {
        return JSON.parse(localStorage.getItem('favorites') || '{}');
    } catch (err) {
        log('Corrupt or legacy favorites data, resetting.', 'warn');
        return {};
    }
}

function saveFavorites(favorites) {
    localStorage.setItem('favorites', JSON.stringify(favorites));
}

/**
 * Mark as favorite
 *
 * @param {HTMLElement} element
 */
function star(element) {
    const e = element.classList;
    const acPath = element.dataset.ac;
    const liveryName = element.dataset.name;
    const favorites = getFavorites();
    const list = favorites[acPath] || [];

    if (e.contains("checked")) {
        const idx = list.indexOf(liveryName);
        if (idx !== -1) list.splice(idx, 1);
        if (list.length) favorites[acPath] = list;
        else delete favorites[acPath];
        domById('favorites').removeChild(domById([element.id, 'favorite'].join('_')));
    } else {
        favorites[acPath] = [...new Set([...list, liveryName])];
        const btn = domById([element.id, 'button'].join('_'));
        const fbtn = appendNewChild(domById('favorites'), 'li', { id: [element.id, 'favorite'].join('_'), class: 'livery-list-item' });
        fbtn.innerText = btn.children[0].innerText;
    }
    saveFavorites(favorites);
    e.toggle('checked');
}

/**
 * @param {string} id
 */
function createUploadButton(id) {
    const customDiv = document.querySelector('#livery-custom-tab-upload .upload-fields');
    appendNewChild(customDiv, 'input', {
        type: 'file',
        onchange: 'LiverySelector.uploadLivery(this)'
    });
    appendNewChild(customDiv, 'input', {
        type: 'text',
        name: 'textureInput',
        class: 'mdl-textfield__input address-input',
        placeholder: id,
        id: id
    });
    appendNewChild(customDiv, 'br');
}

/**
 * @param {string} id
 * @param {number} i
 */
function createDirectButton(id, idxArray) {
    const customDiv = document.querySelector('#livery-custom-tab-direct .upload-fields');
    let filechooser = appendNewChild(customDiv, 'input', {
        type: 'file',
    });
    filechooser.addEventListener("change", () => {loadLiveryDirect(filechooser, idxArray)})
    appendNewChild(customDiv, 'span').textContent = id;
    appendNewChild(customDiv, 'br');
}

function createColorChooser(name, type, partlist) {
    const customDiv = document.querySelector('#livery-custom-tab-direct .upload-fields');
    const colorInput = appendNewChild(customDiv, 'input', {
        type: 'color',
        name: name,
        class: 'colorChooser',
    });
    colorInput.addEventListener('change', () => changeMaterial(name, colorInput.value, type, partlist));
    appendNewChild(customDiv, 'span').textContent = name;
    appendNewChild(customDiv, 'br');
}

function createUploadColorChooser(name, type, partlist) {
    const customDiv = document.querySelector('#livery-custom-tab-upload .upload-fields');
    const colorInput = appendNewChild(customDiv, 'input', {
        type: 'color',
        name: "textureInput",
        id: name,
        class: 'colorChooser',
    });
    colorInput.addEventListener('change', () => changeMaterial(name, colorInput.value, type, partlist));
    appendNewChild(customDiv, 'span').textContent = name;
    appendNewChild(customDiv, 'br');
}

/**
 * @param {HTMLInputElement} fileInput
 * @param {number} i
 */
function loadLiveryDirect(fileInput, idxArray) {
    log("loaddirect called");
    const reader = new FileReader();
    reader.addEventListener('load', (event) => {
        const airplane = getCurrentAircraft();
        if (!airplane || !Array.isArray(airplane.liveries) || !airplane.liveries[0]) return;
        const textures = airplane.liveries[0].texture;
        const newTexture = event.target.result;
            loadLivery(Array(idxArray.length).fill(newTexture), airplane.index.filter((_, i) => idxArray.includes(i)), airplane.parts.filter((_, i) => idxArray.includes(i)));
        fileInput.value = null;
    });
    // read file (if there is one)
    fileInput.files.length && reader.readAsDataURL(fileInput.files[0]);
}

/**
 * @param {HTMLInputElement} fileInput
 */
function uploadLivery(fileInput) {
    if (!fileInput.files.length)
        return;
    if (!localStorage.imgbbAPIKEY) {
        alert('No imgbb API key saved! Check API tab');
        fileInput.value = null;
        return;
    }
    const form = new FormData();
    form.append('image', fileInput.files[0]);
    if (localStorage.liveryAutoremove === '1')
        form.append('expiration', 3600);

    const settings = {
        'url': `https://api.imgbb.com/1/upload?key=${localStorage.imgbbAPIKEY}`,
        'method': 'POST',
        'timeout': 0,
        'processData': false,
        'mimeType': 'multipart/form-data',
        'contentType': false,
        'data': form
    };

    $.ajax(settings).done(function (response) {
        const jx = JSON.parse(response);
        log(jx.data.url);
        fileInput.nextSibling.value = jx.data.url;
        fileInput.value = null;
        if (!uploadHistory[jx.data.id] || (uploadHistory[jx.data.id].expiration !== jx.data.expiration)) {
            uploadHistory[jx.data.id] = jx.data;
            localStorage.lsUploadHistory = JSON.stringify(uploadHistory);
        }
    });
}

function handleCustomTabs(e) {
    e = e || window.event;
    const src = e.target || e.srcElement;
    const tabId = src.innerHTML.toLocaleLowerCase();
    // iterate all divs and check if it was the one clicked, hide others
    domById('customDiv').querySelectorAll(':scope > div').forEach(tabDiv => {
        if (tabDiv.id != ['livery-custom-tab', tabId].join('-')) {
            tabDiv.style.display = 'none';
            return;
        }
        tabDiv.style.display = '';
        // special handling for each tab, could be extracted
        switch (tabId) {
            case 'upload': {
                const fields = tabDiv.querySelectorAll('input[type="file"]');
                fields.forEach(f => localStorage.imgbbAPIKEY ? f.classList.remove('err') : f.classList.add('err'));
                const apiKeys = !!localStorage.liveryDiscordId && !!localStorage.imgbbAPIKEY;
                tabDiv.querySelector('.livery-submit .api').style.display = apiKeys ? '' : 'none';
                tabDiv.querySelector('.livery-submit .no-api').style.display = apiKeys ? 'none' : '';
            } break;

            case 'download': {
                reloadDownloadsForm(tabDiv);
            } break;

            case 'api': {
                reloadSettingsForm();
            } break;
        }
    });

}

/**
 * reloads texture files for current airplane
 *
 * @param {HTMLElement} tabDiv
 */
function reloadDownloadsForm(tabDiv) {
    const airplane = getCurrentAircraft();
    if (!airplane || !Array.isArray(airplane.liveries)) return;
    const liveries = airplane.liveries;
    const defaults = liveries[0];
    const fields = tabDiv.querySelector('.download-fields');
    fields.innerHTML = '';
    liveries.forEach((livery, liveryNo) => {
        const textures = livery.texture.filter(t => typeof t !== 'object');
        if (!textures.length) return; // ignore material defs
        appendNewChild(fields, 'h7').textContent = livery.name;
        const wrap = appendNewChild(fields, 'div');
        textures.forEach((href, i) => {
            if (typeof href === 'object') return;
            if (liveryNo > 0 && href == defaults.texture[i]) return;
            if (Object.keys(airplane.labels)[i] == undefined) return;
            const link = appendNewChild(wrap, 'a', {
                href, target: '_blank',
                class: "mdl-button mdl-button--raised mdl-button--colored"
            });
            link.textContent = Object.keys(airplane.labels)[i];
        });
    });
}

/**
 * reloads settings form after changes
 */
function reloadSettingsForm() {
    const apiInput = domById('livery-setting-apikey');
    apiInput.placeholder = localStorage.imgbbAPIKEY ?
        'API KEY SAVED ✓ (type CLEAR to remove)' :
        'API KEY HERE';

    const removeCheckbox = domById('livery-setting-remove');
    removeCheckbox.checked = (localStorage.liveryAutoremove === '1');

    const discordInput = domById('livery-setting-discordid');
    discordInput.value = localStorage.liveryDiscordId || '';
}

/**
 * saves setting, gets setting key from event element
 *
 * @param {HTMLElement} element
 */
function saveSetting(element) {
    const id = element.id.replace('livery-setting-', '');
    switch (id) {
        case 'apikey': {
            if (element.value.length) {
                if (element.value.trim().toLowerCase() == 'clear') {
                    delete localStorage.imgbbAPIKEY;
                } else {
                    localStorage.imgbbAPIKEY = element.value.trim();
                }
                element.value = '';
            }
        } break;

        case 'remove': {
            localStorage.liveryAutoremove = element.checked ? '1' : '0';
        } break;

        case 'discordid': {
            localStorage.liveryDiscordId = element.value.trim();
        } break;
    }
    reloadSettingsForm();
}

async function addAirline() {
    let url = prompt("Enter URL to the json file of the airline:");
    if (!links.includes(url)) {
        links.push(url);
        localStorage.links += `,${url}`
        await fetch(url).then(res => res.json()).then(data => airlineobjs.push(data));
        airlineobjs[airlineobjs.length - 1].url = url.trim();
        loadAirlines();
    } else {
        alert("Airline already added");
    }
}
function removeAirline(url) {
    removeItem(links, url.trim());
    if (links.toString().charAt(0) === ","){
        localStorage.links = links.toString().slice(1);
    } else {
        localStorage.links = links.toString();
    }
    airlineobjs.forEach(function (e, index) {
        if (e.url.trim() === url.trim()) {
            airlineobjs.splice(index, 1);
        }
    });
    loadAirlines();
}

/**
 * @returns {object} current aircraft from liveryobj
 */
function getCurrentAircraft() {
    return liveryobj.aircrafts ? liveryobj.aircrafts[getACPath()] : undefined;
}

function getACPath(){
    const fullPath = (typeof geofs !== 'undefined' && geofs.aircraft && geofs.aircraft.instance)
        ? geofs.aircraft.instance.fullPath : undefined;
    if (!fullPath) return undefined;
    const parts = fullPath.split('/');
    return parts[parts.length - 2];
}

function setInstanceId(id, alias, url=undefined) {
    geofs.aircraft.instance.liveryId = {ac_path: getACPath(), idx: id +  LIVERY_ID_OFFSET, url: url, [Symbol.toPrimitive](hint) {if (hint === "default"){if(alias) return alias; else return String(LIVERY_ID_OFFSET);} return null;}};
}

async function updateMultiplayer() {
    // 涂装库 / 多人模块尚未就绪时直接跳过，避免每 5 秒刷屏报错
    if (!liveryobj.aircrafts) return;
    if (typeof multiplayer === 'undefined' || !multiplayer || !multiplayer.visibleUsers) return;
    const users = Object.values(multiplayer.visibleUsers);

    const texturePromises = users.map(async u => {
        let liveryEntry;
        let otherId = u.currentLivery;
        if (otherId !== null && typeof otherId === "object"){
            if (otherId.url === undefined){
                liveryEntry = liveryobj.aircrafts[otherId.ac_path];
                otherId = otherId.idx;
            } else if (Array.isArray(whitelist) && whitelist.includes(otherId.url)){
                if (mpAirlineobjs[otherId.url] === undefined){
                    try {
                        await fetch(otherId.url).then(res => res.json()).then(data => mpAirlineobjs[otherId.url] = data);
                    } catch (err) {
                        log(`Failed to fetch airline data: ${otherId.url}\n${err}`, "error");
                        return; // bail out for this user only, don't crash the whole batch
                    }
                    if (!mpAirlineobjs[otherId.url]?.aircrafts) {
                        log(`Airline JSON missing 'aircrafts' field: ${otherId.url}`, "error");
                        return;
                    }
                    let mp_data;
                    Object.keys(mpAirlineobjs[otherId.url].aircrafts).forEach(ac => {
                        if (liveryobj.aircrafts[ac] !== undefined) { // va file indexed by path
                            mpAirlineobjs[otherId.url].aircrafts[ac].mp = liveryobj.aircrafts[ac].mp;
                        } else { // va indexed by id
                            Object.keys(liveryobj.aircrafts).forEach(ac_path => {
                                let ac = liveryobj.aircrafts[ac_path];
                                if (mpAirlineobjs[otherId.url].aircrafts[ac.acid] !== undefined){
                                    mpAirlineobjs[otherId.url].aircrafts[ac.acid].mp = ac.mp;
                                }
                            });
                        }
                    });
                }
                const mpAirline = mpAirlineobjs[otherId.url];
                if (!mpAirline || !mpAirline.aircrafts) return; // 该 VA 数据缺失，跳过这名玩家
                liveryEntry = mpAirline.aircrafts[otherId.ac_path];
                if (liveryEntry === undefined){ // va indexed by id
                    liveryEntry = mpAirline.aircrafts[u.aircraft];
                }
                otherId = otherId.idx;
            }
        } else {
            Object.keys(liveryobj.aircrafts).forEach(ac_path => {
                let ac = liveryobj.aircrafts[ac_path];
                if (u.aircraft == ac.acid){
                    liveryEntry = ac;
                }
            });
        }
        let textures = [];

        if (!liveryEntry || !u.model || liveryEntry.mp == 'disabled') {
            return; // without livery or disabled
        }

        if (mpLiveryIds[u.id] === otherId) {
            return; // already updated
        }

        if (otherId >= ML_ID_OFFSET && otherId < LIVERY_ID_OFFSET) {
            textures = getMLTexture(u, otherId, liveryEntry); // ML range 1k–10k
        } else if (
            (otherId >= LIVERY_ID_OFFSET && otherId < LIVERY_ID_OFFSET * 2)
        ) {
            textures = await getMPTexture(u, liveryEntry, otherId); // LS range 10k+10k
        } else {
            return; // game-managed livery
        }

        textures.forEach(texture => {
            if (texture.material !== undefined) {
                applyMPMaterial(
                    u.model,
                    texture.material,
                    texture.type,
                    texture.color
                );
            } else {
                applyMPTexture(
                    texture.uri,
                    texture.tex,
                    img => u.model.changeTexture(img, { index: texture.index })
                );
            }
        });
        mpLiveryIds[u.id] = otherId;
    });

    await Promise.all(texturePromises); // wait for all user updates to complete
}

/**
 * Fetch and resize texture to expected format
 * @param {string} url
 * @param {sd} tex
 * @param {function} cb
 */
function applyMPTexture(url, tex, cb) {
    try {
        Cesium.Resource.fetchImage({ url }).then(img => {
            const canvas = createTag('canvas', { width: tex._width, height: tex._height });
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            cb(canvas.toDataURL('image/png'));
        });
    } catch (e) {
        log(['LSMP', !!tex, url, e].join("\n"));
    }
}

function applyMPMaterial(model, name, type, color){
    model._model.getMaterial(name).setValue(type, new Cesium.Cartesian4(...color, 1.0));
}

/**
 * @param {object} u
 * @param {object} liveryEntry
 * @param {int} otherId
 */
async function getMPTexture(u, liveryEntry, otherId) {
    otherId = otherId - LIVERY_ID_OFFSET;
    const textures = [];
    // check model for expected textures
    const uModelTextures = u.model._model._rendererResources.textures;
    if (!u.currentLivery) return []; // early return in case of missing livery

    const texturePromises = liveryEntry.mp.map(async e => {
        if (e.textureIndex !== undefined) {
            return {
                uri: liveryEntry.liveries[otherId].texture[e.textureIndex],
                tex: uModelTextures[e.modelIndex],
                index: e.modelIndex
            };
        } else if (e.material !== undefined) {
            const mat = liveryEntry.liveries[otherId].materials[e.material];
            const typeKey = Object.keys(mat)[1];
            return {
                material: mat.name,
                type: typeKey,
                color: mat[typeKey]
            };
        } else if (e.mosaic !== undefined) {
            const mosaicTexture = await generateMosaicTexture(
                e.mosaic.base,
                e.mosaic.tiles,
                liveryEntry.liveries[otherId].texture
            );
            return {
                uri: mosaicTexture,
                tex: uModelTextures[e.modelIndex],
                index: e.modelIndex
            };
        }
    });

    const resolvedTextures = await Promise.all(texturePromises);
    textures.push(...resolvedTextures);
    log("getMPtexture\n" + textures);
    return textures;
}

/**
 * @param {object} u
 * @param {object} liveryEntry
 */
function getMLTexture(u, otherId, liveryEntry) {
    if (!mLiveries.aircraft) {
        fetch(atob(liveryobj.mapi)).then(data => data.json()).then(json => {
            Object.keys(json).forEach(key => mLiveries[key] = json[key]);
        });
        return [];
    }
    const liveryId = otherId - ML_ID_OFFSET;
    const textures = [];
    textures.push({
        uri: mLiveries.aircraft[liveryId].mptx,
        tex: u.model._model._rendererResources.textures[liveryEntry.mp[0].modelIndex],
        index: liveryEntry.mp[0].modelIndex
    });
    return textures;
}

async function generateMosaicTexture(url, tiles, textures) {
    const baseImage = await Cesium.Resource.fetchImage({ url });
    const canvas = createTag('canvas', { width: baseImage.width, height: baseImage.height });
    const ctx = canvas.getContext('2d');

    // Draw the base image first
    ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);

    // Create an array of Promises for drawing all tiles
    const drawTilePromises = tiles.map(async (tile) => {
        const image = await Cesium.Resource.fetchImage({ url: textures[tile.textureIndex] });
        ctx.drawImage(
            image,
            tile.sx, tile.sy, tile.sw, tile.sh,
            tile.dx, tile.dy, tile.dw, tile.dh
        );
    });

    // Wait for all tiles to be drawn
    await Promise.all(drawTilePromises);

    // Now canvas is fully rendered; return the data URL
    return canvas.toDataURL('image/png');
}

/******************* Utilities *********************/

/**
 * @param {string} id Div ID to toggle, in addition to clicked element
 */
function toggleDiv(id) {
    var $e = $(`#${id}`);
    $e.toggle();
    $(window.event.target).toggleClass("closed", $e.css("display") === "none");
}

/**
 * Create tag with <name attributes=...
 *
 * @param {string} name
 * @param {Object} attributes
 * @param {string|number} content
 * @returns {HTMLElement}
 */
function createTag(name, attributes = {}, content = '') {
    const el = document.createElement(name);
    Object.keys(attributes || {}).forEach(k => el.setAttribute(k, attributes[k]));
    if (('' + content).length) {
        el.innerHTML = content;
    }
    return el;
}

function safeCreateTag(name, attributes = {}, content = '') {
    const el = document.createElement(name);
    Object.keys(attributes || {}).forEach(k => el.setAttribute(k, attributes[k]));
    if (('' + content).length) {
        el.textContent = content;
    }
    return el;
}

/**
 * Creates a new element <tagName attributes=...
 * appends to parent and returns the child for later access
 *
 * @param {HTMLElement} parent
 * @param {string} tagName
 * @param {object} attributes
 * @param {number} pos insert in Nth position (default append)
 * @returns {HTMLElement}
 */
function appendNewChild(parent, tagName, attributes = {}, pos = -1) {
    const child = createTag(tagName, attributes);
    if (pos < 0) {
        parent.appendChild(child);
    } else {
        parent.insertBefore(child, parent.children[pos]);
    }

    return child;
}

function removeItem(array, itemToRemove) {
    const index = array.indexOf(itemToRemove);
    if (index !== -1) {
        array.splice(index, 1);
    }
}

/**
 * 仅接受合法的绝对 http(s) 地址，用于过滤 localStorage 中被污染 / 相对的链接
 * @param {string} value
 * @returns {boolean}
 */
function isValidHttpUrl(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return false;
    try { new URL(value.trim()); return true; } catch (e) { return false; }
}

/**
 * @param {string} elementId
 * @returns {HTMLElement}
 */
function domById(elementId) {
    return document.getElementById(elementId);
}

/******************* HTML & CSS Templates *********************/

/**
 * @returns {string} HTML template for main panel
 */
function generateListHTML() {
    return `
        <h3><img src="${noCommit}/liveryselector-logo.svg" class="livery-title" title="LiverySelector" /></h3>

        <div class="livery-searchbar mdl-textfield mdl-js-textfield geofs-stopMousePropagation geofs-stopKeyupPropagation">
            <input class="mdl-textfield__input address-input" type="text" placeholder="Search liveries" onkeyup="LiverySelector.search(this.value)" id="searchlivery">
            <label class="mdl-textfield__label" for="searchlivery">Search liveries</label>
        </div>
        <button class="mdl-button mdl-js-button mdl-button--raised mdl-button potato-mode-search" style="margin-left:auto; margin-top: -60px;">search</button>
        <h6 onclick="LiverySelector.toggleDiv('favorites')">Favorited Liveries</h6>
        <ul id="favorites" class="geofs-list geofs-visible"></ul>

        <h6 onclick="LiverySelector.toggleDiv('liverylist')">Available Liveries</h6>
        <ul id="liverylist" class="geofs-list geofs-visible"></ul>

        <h6 onclick="LiverySelector.toggleDiv('airlinelist')">Virtual Airlines</h6><button class="mdl-button mdl-js-button mdl-button--raised mdl-button" style="background-color: #096628; color: white;" onclick="LiverySelector.addAirline()">+ Add Airline</button>
        <ul id="airlinelist" class="geofs-list geofs-visible"></ul>

        <h6 onclick="LiverySelector.toggleDiv('customDiv')" class="closed">Load External Liveries</h6>
        <div id="customDiv" class="mdl-textfield mdl-js-textfield geofs-stopMousePropagation geofs-stopKeyupPropagation" style="display:none;">
            <ul class="livery-custom-tabs" onclick="LiverySelector.handleCustomTabs()">
                <li>Upload</li>
                <li>Direct</li>
                <li>Download</li>
                <li>API</li>
            </ul>
            <div id="livery-custom-tab-upload" style="display:none;">
                <div>Paste URL or upload image to generate ImgBB URL</div>
                <div class="upload-fields"></div>
                <div><button class="mdl-button mdl-js-button mdl-button--raised mdl-button--colored" onclick="LiverySelector.inputLivery()">Load livery</button></div>
                <div class="livery-submit geofs-list-collapsible-item">Contribute to the LiverySelector Database
                    <div class="geofs-collapsible no-api">-&gt; Enter your ImgBB API Key and Discord User ID in the API tab.</div>
                    <div class="geofs-collapsible api">
                        <label for="livery-submit-liveryname">Livery Name</label>
                        <input type="text" id="livery-submit-liveryname" class="mdl-textfield__input address-input">
                        <label for="livery-submit-credits">Author</label>
                        <input type="text" id="livery-submit-credits" class="mdl-textfield__input address-input">
                        <input type="checkbox" id="livery-submit-confirm-perms">
                        <label for="livery-submit-confirm-perms">I am the author and have created the textures myself, or have permission from the author to use those textures.</label><br>
                        <input type="checkbox" id="livery-submit-confirm-legal">
                        <label for="livery-submit-confirm-legal">I confirm the textures are safe for all ages and audiences, non-offensive, appropriate, high-quality, and don't violate any laws or other regulations.</label>
                        <button class="mdl-button mdl-js-button mdl-button--raised mdl-button--colored" onclick="LiverySelector.submitLivery()">Submit livery for review</button>
                        <small>
                        Join our <a href="https://discord.gg/2tcdzyYaWU" target="_blank">Discord</a> to follow up on your contributions.
                        By submitting the livery, you agree to the <a href="https://discord.com/terms" target="_blank">Discord Terms of Service</a> and our Discord server rules. Failing to comply may result in your submissions being ignored.
                        </small>
                    </div>
                </div>
            </div>
            <div id="livery-custom-tab-direct" style="display:none;">
                <div>Load texture directly in client, no upload.</div>
                <div class="upload-fields"></div>
            </div>
            <div id="livery-custom-tab-download" style="display:none;">
                <div>Download textures for current aircraft:</div>
                <div class="download-fields"></div>
            </div>
            <div id="livery-custom-tab-api" style="display:none;">
            <div>
                <label for="livery-setting-apikey">Paste your imgbb API key here (<a href="https://api.imgbb.com" target="_blank">get key</a>)</label>
                <input type="text" id="livery-setting-apikey" class="mdl-textfield__input address-input" onchange="LiverySelector.saveSetting(this)">
                <input type="checkbox" id="livery-setting-remove" onchange="LiverySelector.saveSetting(this)">
                <label for="livery-setting-remove">Expire links after one hour<br><small>(only for testing, disable when submitting to the database!)</small></label>
                <label for="livery-setting-discordid">Discord User ID (<a href="https://support.discord.com/hc/en-us/articles/206346498" target="_blank">howto</a>)</label>
                <input type="number" id="livery-setting-discordid" class="mdl-textfield__input address-input" onchange="LiverySelector.saveSetting(this)">
            </div>
            </div>
        </div>
        <div style="width: 100%; padding-left: 5px;margin-top: 10px;">
            <label class="mdl-switch mdl-js-switch mdl-js-ripple-effect" for="livery-potato-mode" id="livery-potato-mode-label">
                <input type="checkbox" id="livery-potato-mode" class="mdl-switch__input" data-gespref="geofs.preferences.liveryPotato">
                <span class="mdl-switch__label">Potato mode</span>
            </label>
        </div>
        <br/>
        <a href="https://github.com/kolos26/GEOFS-LiverySelector/tree/main/tutorial" target="_blank"><button class="mdl-button mdl-js-button mdl-button--raised mdl-button">Open Tutorial</button></a><br/>
        <a href="https://discord.gg/2tcdzyYaWU" target="_blank"><button class="mdl-button mdl-js-button mdl-button--raised mdl-button">Join Our Discord</button></a><br/>
        <a href="https://github.com/kolos26/GEOFS-LiverySelector" target="_blank"><button class="mdl-button mdl-js-button mdl-button--raised mdl-button">Visit our Github page</button></a><br/>
        <a href="mailto:LiverySelector20220816@gmail.com" target="_blank"><button class="mdl-button mdl-js-button mdl-button--raised mdl-button">Contact Us: LiverySelector20220816@gmail.com</button></a><br/>
`;
}

/**
 * @returns {HTMLElement} HTML template for main menu livery button
 */
function generatePanelButtonHTML() {
    const liveryButton = createTag('button', {
        title: 'Change livery',
        id: 'liverybutton',
        onclick: 'LiverySelector.togglePanel()',
        class: 'mdl-button mdl-js-button geofs-f-standard-ui geofs-mediumScreenOnly',
        'data-toggle-panel': '.livery-list',
        'data-tooltip-classname': 'mdl-tooltip--top',
        'data-upgraded': ',MaterialButton'
    });
    liveryButton.innerHTML = createTag('img', { src: `${noCommit}/liveryselector-logo-small.svg`, height: '30px' }).outerHTML;

    return liveryButton;
}

function togglePanel() {
    const p = document.getElementById('listDiv');
    if (!p) return;
    if (!liveryobj.aircrafts) {
        log('涂装数据尚未加载完成，请稍候再试。', 'warn');
        return;
    }
    console.time('listLiveries');
    try {
        p.dataset.ac != getACPath() && window.LiverySelector.listLiveries();
    } catch (e) {
        log(e, "error");
    }
    console.timeEnd('listLiveries');
}

window.LiverySelector = {
    liveryobj,
    saveSetting,
    toggleDiv,
    loadLivery,
    changeMaterial,
    loadLiveryDirect,
    handleCustomTabs,
    listLiveries,
    star,
    search,
    inputLivery,
    uploadLivery,
    submitLivery,
    uploadHistory,
    loadAirlines,
    addAirline,
    removeAirline,
    airlineobjs,
    setInstanceId,
    togglePanel,
    log,
    potatoSearch,
    // 换装加速相关（便于在控制台手动调用 / 调试）
    loadTexture,
    textureCandidates,
    preloadLiveryTextures
};
