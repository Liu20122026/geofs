/* =========================================================================
 * GeoFS 4.0 — HD* (Rewarded HD / hdstar) 全球地景 · 清晰度增强版 v4.2
 *
 * 【v4.2 清晰度优化（本版重点，基于 v4.1 加速版叠加）】
 *   1. 细节细化阈值调优（最关键）：Cesium 影像底图由 globe
 *      .maximumScreenSpaceError 决定"屏幕误差超过多少像素才去加载更精细
 *      的瓦片"，默认值是 2，偏保守，会让底图看起来比服务端原图糊。
 *      本版收到 1.33（Cesium 作者 Kevin Ring 官方推荐的影像清晰度值），
 *      强制 Cesium 更早请求更高层级瓦片 —— 地面纹理明显更锐利。
 *      若 GeoFS 已经设了更小的值，则尊重其设置、只朝更清晰的方向调。
 *   2. 瓦片缓存扩容：globe.tileCacheSize 默认 100 → 150，回看/来回缩放
 *      时更多高清瓦片常驻内存，不必回退到模糊的低层级重画。
 *   3. 探测失败不再"停在低清"：v4.1 乐观挂载用 17 级起步，一旦层级探测
 *      失败就会一直停在 17 级（偏糊）。v4.2 改为探测连续失败时逐级放宽，
 *      逐步逼近真实可用层级；一旦探测成功立即精确校正回来。
 *   4. 层级缓存有效期 30 分钟 → 6 小时：同一区域再次进入时，首屏直接
 *      用上次探测通的高清层级挂图，而不是"先低清、再校正"。
 *   5. 以上 Cesium 设置会在图层守卫中周期性重申，防止被 GeoFS 复位。
 *
 * 【继承 v4.1 加载速度优化】（本版完整保留，未牺牲首屏速度）
 *   并行层级探测（1~3 次往返）、乐观挂载（首屏不等探测）、层级缓存、
 *   提前校验、Content-Length 省流、Cesium 预取相邻/父级瓦片。
 *   清晰度增强只在"探测异常"这一冷路径上才会多一次重建，常态零额外请求。
 *
 * 【继承 v4 核心修复】
 *   偏远/不知名机场放大后瓦片空白：动态把 maximumLevel 收紧到该地真实
 *   可用层级，超出部分由 Cesium 用低层级影像上采样 —— 模糊但绝不空白。
 *   （本版保留该能力：乐观挂载用 17 级先出图，探测/缓存再校正到真实层级）
 *
 * 【继承 v3】
 *   __hdstar 自有标记防 removeAll 死循环；自动抓取续期 ArcGIS token；
 *   三源自动降级（token → server → services）；地形解析容错。
 *
 * 适用：GeoFS 4.x / Cesium 1-136
 * 注意：粘贴本版前请先刷新页面（旧版守卫定时器无法被新脚本清理）。
 * ========================================================================= */
(function () {
  'use strict';

  if (window.__HDSTAR_V42__ || window.__HDSTAR_V41__ || window.__HDSTAR_V4__) return;
  window.__HDSTAR_V42__ = true;
  window.__HDSTAR_V41__ = true; // 顺带拦住旧版 v4.1，防止同页重复运行
  window.__HDSTAR_V4__ = true;  // 顺带拦住旧版 v4，防止同页重复运行
  window.__HDSTAR_V3__ = true;  // 再拦住旧版 v3

  /* ======================= 配置 ======================= */
  var CFG = {
    MAX_LEVEL: 19,          // 硬上限（HD 级别）
    MIN_LEVEL: 0,
    BRIGHTNESS: 1.0,
    CONTRAST: 0.8,
    SATURATION: 0.7,
    GUARD_MS: 15000,        // 图层守卫间隔
    INSTALL_COOLDOWN: 2500, // 两次挂载最小间隔
    TOKEN_SCAN_MS: 600000,  // token 重新扫描间隔（10 分钟）

    /* ---- v4 层级探测 ---- */
    PROBE_MIN_LEVEL: 13,    // 再往下没探测意义（13 级全球基本都有）
    PROBE_RADIUS_DEG: 0.18, // 相机移动超过约 20km 才重新探测
    PROBE_MIN_MS: 8000,     // 两次探测最小间隔（去抖）
    PROBE_REQ_MS: 6000,     // 单个探测请求超时
    PROBE_TOTAL_MS: 25000,  // 单轮探测总超时
    PLACEHOLDER_BYTES: 3000,// ≤3000 字节的瓦片视为占位图（实测固定 2521B）

    /* ---- v4.1 加载加速 ---- */
    BOOT_FALLBACK_LEVEL: 17, // 乐观挂载用的保守层级（全球绝大多数区域都有）
    CACHE_TTL_MS: 21600000,  // 层级缓存有效期（v4.2：30 分钟 → 6 小时，首屏更常用到高清层级）
    CACHE_GRID_DEG: 0.25,    // 缓存网格粒度（度），约 27km
    PRELOAD_SIBLINGS: true,  // 漫游时预取相邻瓦片
    MAX_REQUESTS: 64,        // 瓦片请求并发上限

    /* ---- v4.2 清晰度增强 ---- */
    MAX_SCREEN_SPACE_ERROR: 1.33, // 细节细化阈值（Cesium 默认 2，越小越清晰；1.33 为官方推荐平衡值）
    TILE_CACHE_SIZE: 150,         // 瓦片缓存条数（Cesium 默认 100，越大回看/缩放越清晰）
    RELAX_ON_PROBE_FAIL: true     // 层级探测失败时逐级放宽，避免长期停在乐观挂载的低清层级
  };

  var TOKEN_URL =
    'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=';
  var SOURCE_URL = {
    server:   'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    services: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
  };
  var TILEMAP_URL = {
    token:   'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap/{z}/{y}/{x}?f=json&token=',
    server:   'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tilemap/{z}/{y}/{x}?f=json',
    services: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tilemap/{z}/{y}/{x}?f=json'
  };

  /* ======================= 状态 ======================= */
  var state = {
    token: null,
    provider: null,
    sourceId: null,
    layer: null,
    fail: {},              // 各源 401/403 失败计数
    lastInstall: 0,
    guardTimer: null,
    tokenTimer: null,
    /* v4 */
    availMax: null,        // 当前使用的可用最大层级
    availMaxTrusted: false,// v4.1：该层级是否来自缓存/探测（可信），乐观值=false
    lastProbe: null,       // 上次探测位置 {lat, lon}
    lastProbeAt: 0,
    probing: false,
    probeFailStreak: 0     // v4.2：层级探测连续失败次数（用于渐进放宽层级）
  };

  function log() {
    try {
      console.log.apply(console, ['[HD*]'].concat([].slice.call(arguments)));
    } catch (e) {}
  }

  /* ======================= 基础探测 ======================= */
  function getViewer() {
    try {
      if (window.geofs && geofs.api) {
        var v = geofs.api.viewer;
        if (v && v.scene) return v;
      }
    } catch (e) {}
    return null;
  }

  function getLayers() {
    var v = getViewer();
    if (!v) return null;
    if (v.imageryLayers) return v.imageryLayers;
    if (v.scene && v.scene.globe && v.scene.globe.imageryLayers) {
      return v.scene.globe.imageryLayers;
    }
    return null;
  }

  function ready() {
    return !!(window.Cesium && window.geofs && geofs.api && getViewer());
  }

  function requestRender() {
    try {
      var v = getViewer();
      if (v && v.scene && typeof v.scene.requestRender === 'function') {
        v.scene.requestRender();
      }
    } catch (e) {}
  }

  /* ======================= Token 抓取与校验 ======================= */
  function decodeBase64Url(s) {
    var b = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return atob(b);
  }

  function parseExp(token) {
    try {
      var seg = String(token).split('.');
      if (seg.length < 2) return 0;
      var json = decodeBase64Url(seg[1]);
      var payload = JSON.parse(decodeURIComponent(escape(json)));
      return payload && payload.exp ? payload.exp : 0;
    } catch (e) {
      return 0;
    }
  }

  function validToken(token) {
    if (!token) return false;
    var exp = parseExp(token);
    if (!exp) return false;
    return exp * 1000 > Date.now() + 120000; // 至少还剩 2 分钟
  }

  function remainMin(token) {
    var exp = parseExp(token);
    if (!exp) return 0;
    return Math.max(0, Math.round((exp * 1000 - Date.now()) / 60000));
  }

  function scanTokens() {
    var found = [];
    var re = /AASTeyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g;

    function push(t) {
      if (t && found.indexOf(t) === -1) found.push(t);
    }
    function scanText(txt) {
      if (!txt || txt.indexOf('AAST') === -1) return;
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(txt))) push(m[0]);
    }

    // 1) 页面内联 script（GeoFS 的 hdstar token 就在这）
    try {
      for (var i = 0; i < document.scripts.length; i++) {
        scanText(document.scripts[i].textContent);
      }
    } catch (e) {}

    // 2) 已知全局变量
    try {
      ['geofs.geoIpToken', 'geofs.arcGisToken', 'geofs.hdToken', 'geofs.arcgisToken']
        .forEach(function (path) {
          var v = path.split('.').reduce(function (o, k) { return o && o[k]; }, window);
          if (typeof v === 'string') push(v);
        });
    } catch (e) {}

    // 3) 已发生过的网络请求
    try {
      performance.getEntriesByType('resource').forEach(function (e) {
        var u = e && e.name;
        if (!u || u.indexOf('token=') === -1) return;
        var m = /[?&]token=([^&]+)/.exec(u);
        if (m) push(decodeURIComponent(m[1]));
      });
    } catch (e) {}

    // 4) 顺带从 <body> 文本里捞（有些版本 token 写在 data 属性里）
    try {
      var html = document.documentElement.innerHTML;
      if (html && html.length < 8000000) scanText(html);
    } catch (e) {}

    // 按有效期从长到短
    return found
      .filter(function (t) { return parseExp(t) > 0; })
      .sort(function (a, b) { return parseExp(b) - parseExp(a); });
  }

  function pickToken() {
    if (validToken(state.token)) return state.token;
    var list = scanTokens();
    for (var i = 0; i < list.length; i++) {
      if (validToken(list[i])) {
        state.token = list[i];
        log('自动获取到可用 ArcGIS token，剩余约 ' + remainMin(list[i]) + ' 分钟');
        return state.token;
      }
    }
    state.token = null;
    return null;
  }

  function hookNetwork() {
    try {
      if (window.fetch && !window.fetch.__hdstar) {
        var origFetch = window.fetch;
        var nf = function (input) {
          try {
            var u = typeof input === 'string' ? input : (input && input.url);
            if (u && String(u).indexOf('token=') !== -1) {
              var m = /[?&]token=([^&]+)/.exec(String(u));
              if (m) {
                var t = decodeURIComponent(m[1]);
                if (validToken(t) && t !== state.token) state.token = t;
              }
            }
          } catch (e) {}
          return origFetch.apply(this, arguments);
        };
        nf.__hdstar = true;
        window.fetch = nf;
      }
    } catch (e) {}

    try {
      if (window.XMLHttpRequest && !XMLHttpRequest.prototype.__hdstar) {
        var origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
          try {
            var u = String(url || '');
            if (u.indexOf('token=') !== -1) {
              var m = /[?&]token=([^&]+)/.exec(u);
              if (m) {
                var t = decodeURIComponent(m[1]);
                if (validToken(t) && t !== state.token) state.token = t;
              }
            }
          } catch (e) {}
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.__hdstar = true;
      }
    } catch (e) {}
  }

  /* ======================= v4.1：层级缓存 ======================= */
  function cacheKey(lat, lon) {
    var g = CFG.CACHE_GRID_DEG;
    return 'hdstar.avail.' + Math.round(lat / g) + '_' + Math.round(lon / g);
  }

  function readCache(lat, lon) {
    try {
      var s = window.localStorage.getItem(cacheKey(lat, lon));
      if (!s) return null;
      var o = JSON.parse(s);
      if (!o || !isFinite(o.level)) return null;
      if (Date.now() - (o.at || 0) > CFG.CACHE_TTL_MS) return null;
      return o; // { level, at }
    } catch (e) {
      return null;
    }
  }

  function writeCache(lat, lon, level) {
    try {
      window.localStorage.setItem(cacheKey(lat, lon),
        JSON.stringify({ level: level, at: Date.now() }));
    } catch (e) {}
  }

  /* ======================= Provider 构建 ======================= */
  function sourceOrder() {
    return state.token ? ['token', 'server', 'services'] : ['server', 'services'];
  }

  function buildUrl(sourceId) {
    if (sourceId === 'token') {
      return TOKEN_URL + encodeURIComponent(state.token || '');
    }
    return SOURCE_URL[sourceId];
  }

  function labelOf(sourceId) {
    if (sourceId === 'token') return 'ArcGIS 官方 token（ibasemaps）';
    if (sourceId === 'server') return 'ESRI 公开端点 server.arcgisonline.com';
    if (sourceId === 'services') return 'ESRI 备用端点 services.arcgisonline.com';
    return sourceId;
  }

  /* 当前应使用的 maximumLevel
   * v4.1：未知时不再顶格 19（偏远地区会白瓦片），而是回落到保守层级，
   *       先出图，等探测/缓存结果再校正。 */
  function effectiveMaxLevel() {
    if (state.availMax != null && isFinite(state.availMax)) {
      return Math.max(CFG.PROBE_MIN_LEVEL, Math.min(state.availMax, CFG.MAX_LEVEL));
    }
    return CFG.BOOT_FALLBACK_LEVEL;
  }

  function buildProvider(sourceId) {
    var maxLvl = effectiveMaxLevel();
    var provider = new Cesium.UrlTemplateImageryProvider({
      url: buildUrl(sourceId),
      tilingScheme: new Cesium.WebMercatorTilingScheme({
        numberOfLevelZeroTilesX: 1,
        numberOfLevelZeroTilesY: 1
      }),
      minimumLevel: CFG.MIN_LEVEL,
      maximumLevel: maxLvl,
      hasAlphaChannel: false,
      enablePickFeatures: false,
      credit: 'Esri'
    });

    // 自有标记：判断是不是"我们的层"，不再依赖 provider.url
    provider.__hdstar = true;
    provider.__source = sourceId;

    try {
      provider.errorEvent.addEventListener(function (err) {
        var code = err && (err.statusCode || err.status ||
          (err.response && err.response.statusCode));
        if (code === 401 || code === 403) {
          state.fail[sourceId] = (state.fail[sourceId] || 0) + 1;
          if (state.fail[sourceId] === 3) {
            log(labelOf(sourceId) + ' 连续返回 ' + code + '，切换到下一个源');
            state.sourceId = null;
            install('source-fail', true);
          }
        }
      });
    } catch (e) {}

    return provider;
  }

  function tint(layer) {
    if (!layer) return;
    try {
      layer.brightness = CFG.BRIGHTNESS;
      layer.contrast = CFG.CONTRAST;
      layer.saturation = CFG.SATURATION;
      layer.alpha = 1.0;
    } catch (e) {}
  }

  /* ======================= 图层校验（核心） ======================= */
  function verify(provider) {
    var layers = getLayers();
    if (!layers) return;

    // 找出所有与目标 provider 相同的层（官方异步 add 可能造成双份）
    var found = [];
    for (var i = 0; i < layers.length; i++) {
      if (layers.get(i).imageryProvider === provider) found.push(i);
    }

    if (found.length === 0) {
      // 官方接口没接管：只移除"我们上一代"的层，绝不动 GeoFS 自己的层
      for (var j = layers.length - 1; j >= 0; j--) {
        var l = layers.get(j);
        var p = l && l.imageryProvider;
        if (p && p.__hdstar && p !== provider) {
          try { layers.remove(l, false); } catch (e) {}
        }
      }
      try {
        // v4：插到顶层，确保 HD 始终盖在 GeoFS 免费底图之上可见
        state.layer = layers.addImageryProvider(provider);
        tint(state.layer);
        log('已挂载全球底图至顶层（当前共 ' + layers.length + ' 层，maximumLevel=' +
            provider.maximumLevel + '）');
      } catch (e) {
        log('插入图层失败：', e && e.message);
      }
    } else {
      // 去重：保留第一份，移除多余的同 provider 层
      for (var k = found.length - 1; k >= 1; k--) {
        try { layers.remove(layers.get(found[k]), false); } catch (e) {}
      }
      state.layer = layers.get(found[0]);
      tint(state.layer);
      log('影像已生效：' + labelOf(provider.__source) +
          '（图层 ' + found[0] + '/' + layers.length + '，maximumLevel=' + provider.maximumLevel + '）');
    }

    document.body.classList.add('geofs-hdstar');
    requestRender();
  }

  /* ======================= 挂载流程 ======================= */
  /* force=true 时绕过冷却（用于探测结果明确、需要立刻校正层级的重建） */
  function install(reason, force) {
    if (!ready()) return false;

    var now = Date.now();
    if (!force && now - state.lastInstall < CFG.INSTALL_COOLDOWN) return false;
    state.lastInstall = now;

    try {
      var token = pickToken();

      var order = sourceOrder();
      var sourceId = order[0];
      for (var i = 0; i < order.length; i++) {
        if ((state.fail[order[i]] || 0) < 3) { sourceId = order[i]; break; }
      }

      var provider = buildProvider(sourceId);
      state.provider = provider;
      state.sourceId = sourceId;

      // 1) 走 GeoFS 官方通道（与原版行为一致，geofs 会自行维护 dataProvider）
      try {
        geofs.api.imageryProvider = provider;
        if (typeof geofs.api.setImageryProvider === 'function') {
          geofs.api.setImageryProvider(
            provider, false,
            CFG.BRIGHTNESS, CFG.CONTRAST, CFG.SATURATION, 'hdstar'
          );
        }
      } catch (e) {
        log('setImageryProvider 异常（已忽略，稍后手动挂层）：', e && e.message);
      }

      // 2) 校验：v4.1 立即一次（官方同步挂载时马上出图），再补偿校验
      verify(provider);

      setTimeout(function () {
        if (state.provider === provider) verify(provider);
      }, 300);

      setTimeout(function () {
        if (state.provider === provider) verify(provider);
      }, 2000);

      // 8s 兜底：官方接口若异步补挂会产生重复层，这里做最后一次去重/补挂
      setTimeout(function () {
        if (state.provider === provider && isHdAlive()) verify(provider);
      }, 8000);

      log('挂载请求：' + reason + ' → ' + labelOf(sourceId) +
          '（maximumLevel=' + provider.maximumLevel + '）');
      return true;
    } catch (e) {
      log('挂载失败：', e && e.message);
      return false;
    }
  }

  /* ======================= v4：层级探测 ======================= */
  /* 经纬度 → WebMercator XYZ 瓦片号（ArcGIS 0 级 1 瓦） */
  function tileXY(lat, lon, z) {
    var n = Math.pow(2, z);
    var x = Math.floor((lon + 180) / 360 * n);
    var rad = lat * Math.PI / 180;
    var y = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
    x = Math.max(0, Math.min(n - 1, x));
    y = Math.max(0, Math.min(n - 1, y));
    return { x: x, y: y };
  }

  function tileUrlFor(sourceId, z, x, y) {
    return buildUrl(sourceId)
      .replace('{z}', z).replace('{y}', y).replace('{x}', x);
  }

  function tilemapUrl(sourceId, z, x, y) {
    var u = TILEMAP_URL[sourceId] || TILEMAP_URL.server;
    if (sourceId === 'token') u += encodeURIComponent(state.token || '');
    return u.replace('{z}', z).replace('{y}', y).replace('{x}', x);
  }

  /* 带超时的 Promise 包装（超时/失败都 resolve 为 failVal，绝不 reject 卡链） */
  function withTimeout(p, ms, failVal) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () {
        if (!done) { done = true; resolve(failVal); }
      }, ms);
      p.then(function (v) {
        if (!done) { done = true; clearTimeout(t); resolve(v); }
      }, function () {
        if (!done) { done = true; clearTimeout(t); resolve(failVal); }
      });
    });
  }

  /* tilemap JSON：{"data":[1]} 缓存存在 / [0] 不存在
   * 401/403/5xx → reject（源异常，上层换源重探）；404 → resolve null（接口不存在） */
  function fetchJson(url) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (r.status === 401 || r.status === 403 || r.status >= 500) {
        throw new Error('src-err ' + r.status);
      }
      if (!r.ok) return null;
      return r.json();
    });
  }

  /* 返回瓦片字节数：0=无数据(404)；>0=实际大小；reject=源异常
   * v4.1：优先用 Content-Length，避免为了数字节把整张瓦片下下来 */
  function fetchTileSize(url) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (r.status === 401 || r.status === 403 || r.status >= 500) {
        throw new Error('src-err ' + r.status);
      }
      if (!r.ok) return 0;

      var cl = null;
      try { cl = (r.headers && r.headers.get) ? r.headers.get('content-length') : null; } catch (e) {}
      if (cl != null) {
        var n = parseInt(cl, 10);
        if (isFinite(n)) {
          try { if (r.body && typeof r.body.cancel === 'function') r.body.cancel(); } catch (e) {}
          return n;
        }
      }

      if (r.arrayBuffer) {
        return r.arrayBuffer().then(function (b) { return b ? b.byteLength : 0; });
      }
      if (r.blob) return r.blob().then(function (b) { return b ? b.size : 0; });
      return 1; // 无法读大小，但 200 即认为有数据
    });
  }

  /* 某源在 (lat,lon) 的 z 级是否真有影像
   * 首选 tilemap（~100B JSON），失败回退"抓瓦片本体按字节识别 2521B 占位图"
   * 返回 { ok:是否有影像, srcBad:源是否异常(401/403/5xx/超时/断网) } */
  function levelAvailable(sourceId, z, lat, lon) {
    var xy = tileXY(lat, lon, z);
    return new Promise(function (resolve) {
      withTimeout(fetchJson(tilemapUrl(sourceId, z, xy.x, xy.y)), CFG.PROBE_REQ_MS, { __err: true })
        .then(function (j) {
          if (j && j.__err) return resolve({ ok: false, srcBad: true }); // 超时/网络/鉴权异常
          if (j && j.data && j.data.length && j.valid !== false) {
            var any = false;
            for (var i = 0; i < j.data.length; i++) {
              if (j.data[i] > 0) { any = true; break; }
            }
            return resolve({ ok: any, srcBad: false });
          }
          // tilemap 不可用（404/接口不存在）→ 抓瓦片本体判断
          withTimeout(fetchTileSize(tileUrlFor(sourceId, z, xy.x, xy.y)), CFG.PROBE_REQ_MS, -1)
            .then(function (n) {
              if (n === -1) return resolve({ ok: false, srcBad: true }); // 异常
              resolve({ ok: n > CFG.PLACEHOLDER_BYTES, srcBad: false }); // ≤3000B 视为占位图
            });
        })
        .catch(function () { resolve({ ok: false, srcBad: true }); });
    });
  }

  /* v4.1 并行探测（取代 v4 的逐级串行下探）
   *   1) 先只试最高级 —— 城市/常去机场 1 次请求即命中（最快路径）
   *   2) 最高级不可用，再并行试低位档（步长 2），一次往返锁定区间
   *   3) 区间内补测一次，得到精确的最大可用层级
   *   最坏约 3 次往返，优于 v4 的最多 7 次；源异常时自动切公共端点重探 */
  function detectMaxLevel(sourceId, lat, lon, cb) {
    var deadline = Date.now() + CFG.PROBE_TOTAL_MS;

    function run(src, done) {
      if (Date.now() > deadline) return done(null);

      levelAvailable(src, CFG.MAX_LEVEL, lat, lon).then(function (top) {
        if (top.srcBad) {
          if (src !== 'server') {
            log('源「' + labelOf(src) + '」探测异常，改用公共端点');
            return run('server', done);
          }
          return done(null);
        }
        if (top.ok) return done(CFG.MAX_LEVEL); // 城市快路径：1 次请求搞定

        // 最高级确实没数据 → 并行试低位档（步长 2），一次往返锁区间
        var rungs = [];
        for (var z = CFG.MAX_LEVEL - 2; z >= CFG.PROBE_MIN_LEVEL; z -= 2) rungs.push(z);
        if (!rungs.length) return done(null);

        Promise.all(rungs.map(function (zz) {
          return levelAvailable(src, zz, lat, lon).then(function (r) {
            return { z: zz, r: r };
          });
        })).then(function (res) {
          var okList = res.filter(function (x) { return x.r.ok; })
                          .map(function (x) { return x.z; })
                          .sort(function (a, b) { return b - a; });
          if (!okList.length) {
            var allBad = res.every(function (x) { return x.r.srcBad; });
            if (allBad && src !== 'server') {
              log('源「' + labelOf(src) + '」探测异常，改用公共端点');
              return run('server', done);
            }
            return done(null);
          }
          var t = okList[0];
          var mid = t + 1;
          if (mid > CFG.MAX_LEVEL) return done(t);
          levelAvailable(src, mid, lat, lon).then(function (r) {
            if (r.srcBad) return done(t);
            return done(r.ok ? mid : t);
          });
        });
      });
    }

    run(sourceId || 'server', cb);
  }

  /* 当前相机位置（机场加载前后都适用） */
  function currentLatLon() {
    try {
      var v = getViewer();
      var c = v.camera.positionCartographic;
      if (c && isFinite(c.latitude)) {
        return {
          lat: Cesium.Math.toDegrees(c.latitude),
          lon: Cesium.Math.toDegrees(c.longitude)
        };
      }
    } catch (e) {}
    return null;
  }

  function farFromLastProbe(lat, lon) {
    if (!state.lastProbe) return true;
    return Math.abs(lat - state.lastProbe.lat) > CFG.PROBE_RADIUS_DEG ||
           Math.abs(lon - state.lastProbe.lon) > CFG.PROBE_RADIUS_DEG;
  }

  /* v4/v4.1 主入口：必要时探测当前位置可用层级，探测结果变化则重建图层 */
  function maybeRecheck(reason) {
    if (!ready() || state.probing) return;
    var now = Date.now();
    if (now - state.lastProbeAt < CFG.PROBE_MIN_MS) return;

    var pos = currentLatLon();
    if (!pos) return;

    // 已有可信结果且没离开原区域 → 零请求（同机场缩放不产生额外请求）
    if (state.availMaxTrusted && state.availMax != null &&
        !farFromLastProbe(pos.lat, pos.lon)) return;

    // v4.1：优先查缓存，命中直接采用，省掉整轮网络探测
    if (!state.availMaxTrusted) {
      var c = readCache(pos.lat, pos.lon);
      if (c) {
        var prevL = state.availMax;
        state.availMax = c.level;
        state.availMaxTrusted = true;
        state.lastProbe = pos;
        state.lastProbeAt = now;
        log('命中层级缓存：' + c.level + ' 级（跳过探测）');
        if (prevL !== c.level || !isHdAlive()) install('relevel-cache', true);
        return;
      }
    }

    state.probing = true;
    state.lastProbeAt = now;
    state.lastProbe = pos;

    var src = state.sourceId || (validToken(state.token) ? 'token' : 'server');
    detectMaxLevel(src, pos.lat, pos.lon, function (L) {
      state.probing = false;
      if (L == null) {
        state.probeFailStreak++;
        // v4.2 清晰度：探测连续失败时逐级放宽层级，避免一直停在乐观挂载的
        // 低清层级（17 级）；一旦探测成功会立即精确校正回真实层级。
        if (CFG.RELAX_ON_PROBE_FAIL && !state.availMaxTrusted) {
          var curL = state.availMax == null ? CFG.BOOT_FALLBACK_LEVEL : state.availMax;
          if (curL < CFG.MAX_LEVEL) {
            var nextL = Math.min(CFG.MAX_LEVEL, curL + 1);
            state.availMax = nextL;
            log('层级探测连续失败 ' + state.probeFailStreak + ' 次，先行放宽到 ' + nextL +
                ' 级提升清晰度（探测成功后会自动校正回真实层级）');
            install('probe-relax-' + nextL, true);
            return;
          }
        }
        log('层级探测失败（' + reason + '），保持当前设置 maximumLevel=' + effectiveMaxLevel());
        if (!isHdAlive()) install('probe-fail');
        return;
      }
      state.probeFailStreak = 0;
      writeCache(pos.lat, pos.lon, L);
      var prev = state.availMax;
      state.availMax = L;
      state.availMaxTrusted = true;
      if (prev !== L) {
        log('当前位置真实可用层级：' + (prev == null ? '（首次）' : prev) + ' → ' + L +
            '，重建图层（放大超出部分自动上采样，不再出现空白瓦片）');
        if (!install('relevel-' + L, true)) {
          // 万一被冷却挡下，稍后补一次，保证一定校正到位
          setTimeout(function () { install('relevel-' + L + '-retry', true); }, 1200);
        }
      } else {
        log('层级探测确认：' + L + ' 级（无需重建）');
      }
    });
  }

  function watchCamera() {
    try {
      var v = getViewer();
      if (v && v.camera && v.camera.moveEnd &&
          typeof v.camera.moveEnd.addEventListener === 'function') {
        v.camera.moveEnd.addEventListener(function () { maybeRecheck('moveEnd'); });
      }
    } catch (e) {}
  }

  /* ======================= 地形（容错） ======================= */
  function installTerrain() {
    try {
      if (!window.Cesium || !window.geofs || !geofs.api) return;

      var Flat = geofs.api.FlatRunwayTerrainProvider;
      if (typeof Flat !== 'function') {
        log('当前版本无 FlatRunwayTerrainProvider，跳过跑道压平');
        return;
      }
      if (!Cesium.CesiumTerrainProvider ||
          typeof Cesium.CesiumTerrainProvider.fromUrl !== 'function') return;

      Cesium.CesiumTerrainProvider.fromUrl('https://data.geo-fs.com/srtm/', {
        requestWaterMask: false,
        requestVertexNormals: true,
        requestMetadata: false
      }).then(function (base) {
        try {
          geofs.api.setTerrainProvider(new Flat({
            baseProvider: base,
            bypass: false,
            maximumLevel: 12
          }), 'geofs');
          log('地形已切换：SRTM + FlatRunway');
        } catch (e) {
          log('设置地形失败，保持原地形：', e && e.message);
        }
      }).catch(function (e) {
        log('地形加载失败，保持原地形：', e && e.message);
      });
    } catch (e) {
      log('地形初始化异常：', e && e.message);
    }
  }

  /* ======================= 底图底色与外观 ======================= */
  function setBaseColor() {
    try {
      var v = getViewer();
      if (v && v.scene && v.scene.globe) {
        v.scene.globe.baseColor = Cesium.Color.fromCssColorString('#16212b');
      }
    } catch (e) {}
  }

  function applyFlags() {
    var b = document.body;
    b.classList.add('geofs-rewarded', 'geofs-subscribed', 'geofs-subscribed-hdstar', 'geofs-hdstar');
    b.classList.remove('geofs-sr', 'geofs-sd', 'geofs-hd', 'geofs-gt');

    try {
      if (window.geofs && geofs.userRecord) geofs.userRecord.subscription = 'hdstar';
    } catch (e) {}

    try {
      window.geofsSetDataProvider = 'hdstar';
      if (window.geofs && geofs.api) geofs.api.dataProvider = 'hdstar';
    } catch (e) {}

    try {
      var logo = document.querySelector('.geofs-hdstar-logo');
      if (logo) logo.style.display = 'inline-block';
    } catch (e) {}
  }

  /* ======================= v4.1/v4.2：Cesium 调优 ======================= */
  function tuneCesium() {
    // 漫游时预取相邻/父级瓦片，减少"看着空、等一会儿才出图"
    try {
      var v = getViewer();
      if (v && v.scene && v.scene.globe) {
        var globe = v.scene.globe;
        try { if (CFG.PRELOAD_SIBLINGS) globe.preloadSiblings = true; } catch (e) {}
        try { globe.preloadAncestors = true; } catch (e) {}

        // v4.2 清晰度：调小细节细化阈值 → Cesium 更早加载更高层级瓦片，地面更锐利
        // 只在"当前值缺失或比目标更粗"时下调；若外部已设更清晰的值则尊重不动
        try {
          var curSse = globe.maximumScreenSpaceError;
          if (typeof curSse !== 'number' || !isFinite(curSse) ||
              curSse > CFG.MAX_SCREEN_SPACE_ERROR) {
            globe.maximumScreenSpaceError = CFG.MAX_SCREEN_SPACE_ERROR;
          }
        } catch (e) {}

        // v4.2 清晰度：瓦片缓存扩容，回看/缩放时保留更多高清瓦片，避免退回模糊低层
        try {
          var curCache = globe.tileCacheSize;
          if (typeof curCache !== 'number' || !isFinite(curCache) ||
              curCache < CFG.TILE_CACHE_SIZE) {
            globe.tileCacheSize = CFG.TILE_CACHE_SIZE;
          }
        } catch (e) {}
      }
    } catch (e) {}

    // 提高瓦片请求并发上限（各 Cesium 版本属性可写性不一，逐个 try 兜底）
    try {
      if (window.Cesium && Cesium.RequestScheduler) {
        var rs = Cesium.RequestScheduler;
        if (typeof rs.maximumRequests === 'number') {
          rs.maximumRequests = Math.max(rs.maximumRequests, CFG.MAX_REQUESTS);
        }
        if (typeof rs.maximumRequestsPerServer === 'number') {
          rs.maximumRequestsPerServer = Math.max(rs.maximumRequestsPerServer, 18);
        }
      }
    } catch (e) {}
  }

  /* ======================= 图层守卫 ======================= */
  function isHdAlive() {
    var layers = getLayers();
    if (!layers || layers.length === 0) return false;
    for (var i = 0; i < layers.length; i++) {
      var item = layers.get(i);
      var p = item && item.imageryProvider;
      if (p && p.__hdstar && item.show !== false) return true;
    }
    return false;
  }

  function startGuard() {
    if (state.guardTimer) clearInterval(state.guardTimer);

    state.guardTimer = setInterval(function () {
      if (!ready()) return;

      // dataProvider 被改回去就纠回 hdstar
      try {
        if (geofs.api.dataProvider && geofs.api.dataProvider !== 'hdstar') {
          geofs.api.dataProvider = 'hdstar';
        }
      } catch (e) {}

      // v4.2：周期性重申 Cesium 清晰度设置，防止被 GeoFS 运行期复位
      tuneCesium();

      // v4：守卫循环顺带做层级复查（内部有半径/冷却闸门，平时零请求）
      maybeRecheck('guard');

      if (!isHdAlive()) {
        log('全球底图图层缺失，自动补挂');
        install('guard');
      }
    }, CFG.GUARD_MS);
  }

  /* ======================= token 周期刷新 ======================= */
  function startTokenWatch() {
    if (state.tokenTimer) clearInterval(state.tokenTimer);
    state.tokenTimer = setInterval(function () {
      var before = state.token;
      var now = require_token_now();
      if (now && now !== before && validToken(now)) {
        log('发现新 token，刷新影像');
        state.fail = {};
        install('token-refresh', true);
      }
    }, CFG.TOKEN_SCAN_MS);
  }

  function require_token_now() {
    var list = scanTokens();
    for (var i = 0; i < list.length; i++) {
      if (validToken(list[i])) return list[i];
    }
    return null;
  }

  /* ======================= geoIpUpdate 包装 ======================= */
  function patchGeoIpUpdate() {
    try {
      if (!window.geofs || geofs.__hdstarPatched) return;
      if (typeof geofs.geoIpUpdate !== 'function') return;
      var orig = geofs.geoIpUpdate;
      geofs.__hdstarPatched = true;
      geofs.geoIpUpdate = function () {
        var r = orig.apply(this, arguments);
        if (!isHdAlive()) install('geoIpUpdate');
        // 换场/刷新后安排一次层级复查
        setTimeout(function () { maybeRecheck('geoIpUpdate'); }, 4000);
        return r;
      };
    } catch (e) {}
  }

  /* ======================= 启动 ======================= */
  function boot() {
    if (!ready()) return;

    if (boot.__done) { applyFlags(); return; }
    boot.__done = true;

    applyFlags();
    setBaseColor();
    patchGeoIpUpdate();
    tuneCesium();

    // v4.1 乐观挂载：先用缓存层级或保守层级立即出图，首屏不再等待探测
    var pos = currentLatLon();
    if (state.availMax == null) {
      var c = pos ? readCache(pos.lat, pos.lon) : null;
      if (c) {
        state.availMax = c.level;
        state.availMaxTrusted = true;
        state.lastProbe = pos;
        log('启动命中层级缓存：' + c.level + ' 级');
      } else {
        state.availMax = CFG.BOOT_FALLBACK_LEVEL;
        state.availMaxTrusted = false;
      }
    }
    if (!isHdAlive()) install('boot-fast');

    // 后台探测真实层级（命中可信缓存时会自动跳过）
    maybeRecheck('boot');

    installTerrain();
    startGuard();
    startTokenWatch();
    watchCamera();

    var v = getViewer();
    if (v) setTimeout(function () { maybeRecheck('boot-delay'); }, 4000);

    log('HD* v4.2 清晰版已启动：清晰度增强（细节阈值 ' + CFG.MAX_SCREEN_SPACE_ERROR +
        '、瓦片缓存 ' + CFG.TILE_CACHE_SIZE + '） + 并行探测 + 乐观挂载 + 层级缓存；数据源：' +
        labelOf(state.sourceId || (validToken(state.token) ? 'token' : 'server')));
  }

  hookNetwork();

  if (typeof window.executeOnEventDone === 'function') {
    window.executeOnEventDone('afterDeferredload', function () {
      applyFlags();
      hookNetwork();
    });
    window.executeOnEventDone('geofsStarted', function () {
      boot();
      setTimeout(boot, 1500);
      setTimeout(boot, 5000);
    });
  }

  // 无论事件是否触发，都做一次轮询兜底（GeoFS 的 executeOnEventDone 不保证回调已注册就执行）
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (ready()) {
      clearInterval(timer);
      boot();
    } else if (tries > 480) {
      clearInterval(timer);
      log('等待 geofs/Cesium 超时（约 2 分钟），请检查注入时机');
    }
  }, 250);
})();
