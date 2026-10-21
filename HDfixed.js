// ==UserScript==
// @name         Better Resolution Terrain (ESRI)
// @namespace    http://tampermonkey.net/
// @version      3.2.0
// @description  ESRI World Imagery high-res tiles for GeoFS — minimal stable version
// @author       drakeerv 
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://beta.geo-fs.com/geofs.php*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=geo-fs.com
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // ===== 配置 =====
    const provider = 'esri';             // 'esri' | 'gaode' | 'google' | 'apple' | 'bing'
    const enableHdTerrain = false;       // false = 不动地形（最稳）；true = 启用 SRTM 高清地形
    // ================

    const LOG_PREFIX = '[BetterTerrain]';
    const log   = m => console.log(`%c${LOG_PREFIX} ${m}`, 'color:#4fc3f7;font-weight:bold');
    const ok    = m => console.log(`%c${LOG_PREFIX} ✅ ${m}`, 'color:#66bb6a;font-weight:bold');
    const warn  = m => console.warn(`${LOG_PREFIX} ⚠️ ${m}`);
    const err   = m => console.error(`${LOG_PREFIX} ❌ ${m}`);

    if (window.__betterTerrainLoaded) {
        warn('脚本已加载过，请 F5 刷新后再粘贴。');
        return;
    }
    window.__betterTerrainLoaded = true;
    window.geofsNewHDState = true;

    function buildImageryProvider() {
        const C = window.Cesium;
        switch (provider) {
            case 'esri':
                // 关键：用 server.arcgisonline.com（国内可达），直接拼瓦片 URL，不拉 metadata
                return new C.UrlTemplateImageryProvider({
                    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                    maximumLevel: 19,
                    hasAlphaChannel: false,
                    credit: '© Esri, Maxar, Earthstar Geographics'
                });
            case 'gaode':
                return new C.UrlTemplateImageryProvider({
                    url: 'https://{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
                    subdomains: ['webst01', 'webst02', 'webst03', 'webst04'],
                    maximumLevel: 18, hasAlphaChannel: false, credit: '© 高德地图'
                });
            case 'google':
                return new C.UrlTemplateImageryProvider({
                    url: 'https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
                    subdomains: ['mt0','mt1','mt2','mt3'],
                    maximumLevel: 21, hasAlphaChannel: false
                });
            case 'apple':
                return new C.UrlTemplateImageryProvider({
                    url: 'https://{s}.apple-mapkit.com/tile?style=7&size=1&scale=1&z={z}&x={x}&y={y}&v=9651&accessKey=1705988638_4603104305979553294_%2F_Qvq1XXyXG5w0IUYlFOsIQsxLt2ALxm32i%2BAMbLIFD5s%3D',
                    subdomains: ['sat-cdn1','sat-cdn2','sat-cdn3','sat-cdn4'],
                    maximumLevel: 21, hasAlphaChannel: false
                });
            case 'bing':
                return new C.BingMapsImageryProvider({
                    url: 'https://dev.virtualearth.net',
                    key: 'AjrgR5TNicgFReuFwvNH71v4YeQNkXIB20l63ZMm86mVuBGZPhTHMkdiVq2_9L7x',
                    mapStyle: C.BingMapsStyle.AERIAL
                });
            default: return null;
        }
    }

    function applyHD() {
        const g = window.geofs;
        const C = window.Cesium;
        if (!g || !g.api || !g.api.viewer || !C) return false;

        log(`切换影像源: ${provider} ...`);
        try { delete g.api.analytics; } catch (_) {}
        try { document.body.classList.add('geofs-hd'); } catch (_) {}

        const ip = buildImageryProvider();
        if (!ip) { err(`未知 provider: ${provider}`); return false; }
        g.api.imageryProvider = ip;
        g.api.setImageryProvider(ip, false);   // 用 GeoFS 官方方法切换，最稳
        ok(`影像源已切换: ${provider}`);

        if (enableHdTerrain) {
            try {
                g.api.viewer.terrainProvider = g.api.flatRunwayTerrainProviderInstance =
                    new g.api.FlatRunwayTerrainProvider({
                        baseProvider: new C.CesiumTerrainProvider({
                            url: 'https://data.geo-fs.com/srtm/',
                            requestWaterMask: false, requestVertexNormals: true
                        }),
                        bypass: false, maximumLevel: 12
                    });
                ok('SRTM 高清地形已启用');
            } catch (e) { err(`地形切换失败（保持默认）: ${e.message}`); }
        } else {
            log('高清地形未启用（保持默认地形，避免黑屏）。');
        }

        g.api.hdOn = window.geofsNewHDState;
        try { if (typeof g.api.renderingQuality === 'function') g.api.renderingQuality(); } catch (_) {}
        try { if (window.jQuery) {
            window.jQuery('body').trigger('terrainProviderWillUpdate');
            window.jQuery('body').trigger('terrainProviderUpdate');
        }} catch (_) {}

        ok(`高清影像已启用（${provider}），瓦片正在加载...`);
        return true;
    }

    function tryApply() {
        if (applyHD()) { window.__betterTerrainApplied = true; return true; }
        return false;
    }

    let waited = 0;
    const timer = setInterval(() => {
        waited += 300;
        if (window.Cesium && window.geofs && window.geofs.api && window.geofs.api.viewer) {
            clearInterval(timer);
            setTimeout(() => { if (!tryApply()) err('应用失败，请刷新重试'); }, 1000);
            return;
        }
        if (waited >= 60000) { clearInterval(timer); err('等待 GeoFS 就绪超时。'); }
    }, 300);

    if (typeof window.executeOnEventDone === 'function') {
        window.executeOnEventDone('geofsStarted', function() {
            if (window.__betterTerrainApplied) return;
            setTimeout(tryApply, 1500);
        });
        window.executeOnEventDone('afterDeferredload', function() {
            try { window.geofs.mapXYZ = 'https://data.geo-fs.com/osm/{z}/{x}/{y}.png'; } catch (_) {}
        });
    }
})();
