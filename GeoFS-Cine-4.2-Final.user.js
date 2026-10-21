// ==UserScript==
// @name         GeoFS Cine 4.2 Final · XP12 真实感
// @namespace    geofs.cine
// @version      4.2.0
// @description  ACES 调色 + 距离大气透视 + 高度雾 + 前向散射；草地降饱和 −10%、锐化减半、黑位提升、雾密度 +12%；保留 4.0 的云 / 水 / OSM 建筑 / 程序化音效 / HUD / 性能分级；新增预设、参数持久化、着色器失败自动回退
// @match        https://www.geo-fs.com/*
// @match        https://*.geo-fs.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* =====================================================================
 * GeoFS Cine 4.2 Final
 * ---------------------------------------------------------------------
 * 相对 4.1 的变化（都是工程性修补，不改上一轮定下的调色方向）：
 *   1. 预设系统：noon / dusk / overcast 三套，HUD 一键切换
 *   2. 参数持久化：localStorage 记住你的微调，双击标题恢复默认
 *   3. 着色器失败自动回退：GLSL 编译/链接报错时关掉 aerial，接回原生雾，
 *      不会再出现"装上后远景一片死白但不知道为什么"
 *   4. 深度有效性保护：depth 为 0 或 1 的像素直接跳过，天空不参与雾化
 *   5. 性能分级加冷却与滞回，避免 FPS 在阈值附近来回跳档
 *   6. HUD 加折叠、状态点、预设名，爆音/建筑/云的状态一眼可见
 *   7. 诊断信息补 preset / fogMode / errors / depthTexture
 * ---------------------------------------------------------------------
 * 调参入口：下面的 DEFAULTS。改完保存即可，不要改 shader 里的常量。
 * ===================================================================== */

(function () {
  'use strict';
  if (window.__geofsCine42) return;
  window.__geofsCine42 = true;
  // 同时占住 4.1 的标记：后加载的 4.1 会自动退出，避免双重后处理
  window.__geofsCine4 = true;

  /* =====================================================================
   * 0. 默认参数
   * ===================================================================== */
  var DEFAULTS = {
    preset: 'noon',

    // 总开关
    xp12: true,
    grade: true,
    aerial: true,
    bloom: true,

    // 调色
    exposure: 1.00,
    wb: [1.02, 1.00, 0.98],     // 中性微暖，不靠橙光找氛围
    contrast: 1.03,
    saturation: 1.04,
    greenDesat: 0.90,           // 草地/植被饱和 −10%
    shadowLift: 0.012,          // 只抬黑位
    sharpen: 0.28,              // 4.0 是 0.32；0.16 可完全去晕边
    protect: [0.20, 0.55],      // 锐化的边缘保护区间
    vignette: 0.12,
    grain: 0.010,

    // 大气透视（替代 Cesium 原生 fog）
    fogDensity: 0.000122,       // 按 8km 尺度标定
    fogHeightFalloff: 0.00028,  // 1/m，e 折约 3.6km
    fogMax: 0.62,               // 防止远景彻底糊死
    fogStrength: 1.0,
    nativeFogDensity: 0.000063, // aerial 关闭时的兜底雾
    horizonColor: [0.855, 0.888, 0.925],
    zenithColor: [0.420, 0.550, 0.720],
    fogColor: [0.800, 0.842, 0.882],
    aerialDistance: 22000,

    // 场景
    clouds: true,
    cloudCount: 52,
    water: true,
    fov: 0.95,                  // 弧度，约 54°
    volume: 0.22,
    hud: true,

    // OSM 建筑
    osm: true,
    osmMaxBuildings: 320,
    osmMaxTiles: 4,
    maxAltOsm: 6500
  };

  var PRESETS = {
    noon: {},   // 默认值本身就是正午强光
    dusk: {
      exposure: 0.98,
      wb: [1.05, 1.00, 0.955],
      contrast: 1.05,
      saturation: 1.02,
      greenDesat: 0.88,
      shadowLift: 0.016,
      sharpen: 0.24,
      vignette: 0.17,
      fogDensity: 0.000155,
      fogMax: 0.66,
      horizonColor: [0.915, 0.868, 0.812],
      zenithColor: [0.300, 0.420, 0.620],
      fogColor: [0.820, 0.812, 0.800]
    },
    overcast: {
      exposure: 1.05,
      wb: [1.00, 1.00, 1.02],
      contrast: 0.97,
      saturation: 0.95,
      greenDesat: 0.82,
      shadowLift: 0.020,
      sharpen: 0.18,
      vignette: 0.10,
      fogDensity: 0.000210,
      fogMax: 0.70,
      fogStrength: 1.05,
      horizonColor: [0.800, 0.818, 0.842],
      zenithColor: [0.520, 0.578, 0.660],
      fogColor: [0.775, 0.795, 0.818]
    }
  };

  var PRESET_ORDER = ['noon', 'dusk', 'overcast'];
  var PRESET_LABEL = { noon: '正午', dusk: '晨昏', overcast: '灰调' };
  var STORE_KEY = 'geofs.cine42';

  function cloneVal(v) {
    return Object.prototype.toString.call(v) === '[object Array]' ? v.slice() : v;
  }

  var CFG = {};
  (function () {
    var k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) CFG[k] = cloneVal(DEFAULTS[k]);
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      for (k in DEFAULTS) {
        if (!Object.prototype.hasOwnProperty.call(saved, k)) continue;
        var dv = DEFAULTS[k], sv = saved[k];
        if (Object.prototype.toString.call(dv) === '[object Array]') {
          if (Object.prototype.toString.call(sv) === '[object Array]') CFG[k] = sv.slice();
        } else if (typeof sv === typeof dv) {
          CFG[k] = sv;
        }
      }
    } catch (e) { /* 隐私模式或脏数据：静默用默认值 */ }
  })();

  function saveCfg() {
    try {
      var out = {};
      for (var k in DEFAULTS) {
        if (Object.prototype.hasOwnProperty.call(CFG, k)) out[k] = CFG[k];
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch (e) { /* 忽略 */ }
  }

  /* =====================================================================
   * 1. 状态与工具
   * ===================================================================== */
  var S = {
    viewer: null, fps: 0, level: 0, appliedLevel: -1,
    bloom: null, stage: null, aerial: null,
    clouds: null, cloudMode: null,
    cloudTex: null, cloudAnchor: null, audio: null,
    alt: 0, spd: 0, vs: 0, hdg: 0, hud: null,
    lastPos: null, lastAlt: 0, lastT: 0,
    camHeight: 0, started: false,
    errors: [], degraded: false, lastLevelAt: 0, levelVotes: 0
  };

  var OSM = { tiles: new Map(), inflight: new Set(), last: 0 };

  var safe = function (fn) { try { return fn(); } catch (e) { return undefined; } };
  var C = function () { return window.Cesium; };

  function getViewer() {
    var g = window.geofs;
    if (g && g.api && g.api.viewer) return g.api.viewer;
    if (window.viewer && window.viewer.scene) return window.viewer;
    return null;
  }

  function vec3(Ce, arr) {
    return new Ce.Cartesian3(arr[0], arr[1], arr[2]);
  }

  /* =====================================================================
   * 2. 核心场景参数
   * ===================================================================== */
  function applyCore(v) {
    var sc = v.scene, g = sc.globe, Ce = C();

    safe(function () { v.resolutionScale = 1; });
    safe(function () { if ('useBrowserRecommendedResolution' in v) v.useBrowserRecommendedResolution = false; });
    safe(function () { if ('targetFrameRate' in v) v.targetFrameRate = 60; });
    safe(function () { sc.msaaSamples = 4; });
    safe(function () { sc.postProcessStages.fxaa.enabled = true; });
    safe(function () { v.camera.frustum.fov = CFG.fov; });

    if (g) {
      g.enableLighting = true;
      if ('dynamicAtmosphereLighting' in g) g.dynamicAtmosphereLighting = true;
      if ('dynamicAtmosphereLightingFromSun' in g) g.dynamicAtmosphereLightingFromSun = true;
      if ('showGroundAtmosphere' in g) g.showGroundAtmosphere = true;
      if ('atmosphereLightIntensity' in g) g.atmosphereLightIntensity = 12;
      if ('lambertDiffuseMultiplier' in g) g.lambertDiffuseMultiplier = 1.0;
      if ('showWaterEffect' in g) g.showWaterEffect = CFG.water;
      if ('dynamicLighting' in g && Ce && Ce.DynamicAtmosphereLightingType) {
        g.dynamicLighting = Ce.DynamicAtmosphereLightingType.ATMOSPHERE;
      }
    }

    // 原生 fog 与自定义大气透视会叠成"双层灰"：同一时刻只留一个
    if (sc.fog) {
      sc.fog.enabled = !(CFG.xp12 && CFG.aerial && !S.degraded);
      if ('density' in sc.fog) sc.fog.density = CFG.nativeFogDensity;
    }

    if (sc.skyAtmosphere) {
      sc.skyAtmosphere.show = true;
      if ('brightnessShift' in sc.skyAtmosphere) sc.skyAtmosphere.brightnessShift = 0.06;
      if ('saturationShift' in sc.skyAtmosphere) sc.skyAtmosphere.saturationShift = -0.04;
      if ('hueShift' in sc.skyAtmosphere) sc.skyAtmosphere.hueShift = 0.0;
    }
  }

  /* =====================================================================
   * 3. 着色器
   * ===================================================================== */
  function glslHead(Ce) {
    var v = String((Ce && Ce.VERSION) || '1.0').split('.').map(Number);
    var isNew = v[0] > 1 || (v[0] === 1 && v[1] >= 87);
    return {
      decl: isNew ? 'in vec2 v_textureCoordinates;' : 'varying vec2 v_textureCoordinates;',
      tex: isNew ? 'texture' : 'texture2D',
      out: isNew ? 'out_FragColor' : 'gl_FragColor'
    };
  }

  /* ---------------------------------------------------------------
   * 3.1 大气透视
   *     depth → 视空间距离 → 高度雾 → 前向散射 → 距离掺天顶蓝
   * --------------------------------------------------------------- */
  function aerialShader(Ce) {
    var h = glslHead(Ce);
    return [
      'uniform sampler2D colorTexture;',
      h.decl,
      'uniform float uDensity;',
      'uniform float uFalloff;',
      'uniform float uMax;',
      'uniform float uStrength;',
      'uniform float uCamHeight;',
      'uniform float uDistScale;',
      'uniform vec3  uHorizon;',
      'uniform vec3  uZenith;',
      'uniform vec3  uFog;',

      'void main() {',
      '  vec2 uv = v_textureCoordinates;',
      '  vec4 src = ' + h.tex + '(colorTexture, uv);',
      '  vec3 col = src.rgb;',
      '  vec3 outCol = col;',

      // depth 为 0 或 1 都不可信：天空 / 未写入深度的像素交给 skyAtmosphere
      '  float d = ' + h.tex + '(czm_globeDepthTexture, uv).r;',
      '  if (d > 0.000001 && d < 0.99999) {',
      '    vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);',
      '    vec4 eye = czm_inverseProjection * ndc;',
      '    eye /= max(eye.w, 1e-6);',
      '    float dist = length(eye.xyz);',
      '    vec3 vdir = eye.xyz / max(dist, 1e-3);',

      // 高度衰减：贴地浓、高空稀，形成"雾层"而不是均匀灰
      '    float hgt = max(uCamHeight, 0.0);',
      '    float dens = uDensity * exp(-hgt * uFalloff);',
      '    float amt = 1.0 - exp(-dist * dens);',
      '    amt = min(amt, uMax) * uStrength;',

      // 前向散射：朝太阳看更亮更暖
      '    vec3 wdir = normalize((czm_inverseView * vec4(vdir, 0.0)).xyz);',
      '    float mu = dot(wdir, normalize(czm_sunDirectionWC));',
      '    float phase = 0.75 * (1.0 + mu * mu);',
      '    vec3 fc = mix(uFog, uHorizon, smoothstep(-0.15, 0.60, vdir.y));',
      '    fc *= mix(0.90, 1.12, phase);',

      // 越远越往天顶蓝靠：远山退成蓝灰，而不是整体糊白
      '    fc = mix(fc, uZenith, clamp(dist / uDistScale, 0.0, 0.50));',
      '    outCol = mix(col, fc, clamp(amt, 0.0, 1.0));',
      '  }',

      '  ' + h.out + ' = vec4(outCol, src.a);',
      '}'
    ].join('\n');
  }

  /* ---------------------------------------------------------------
   * 3.2 调色
   *     受控锐化 → 线性化 → 白平衡 → 绿色蒙版降饱和
   *     → 黑位提升 → ACES → 对比 → 暗角 → 颗粒
   * --------------------------------------------------------------- */
  function gradeShader(Ce) {
    var h = glslHead(Ce);
    return [
      'uniform sampler2D colorTexture;',
      h.decl,
      'uniform float uExposure;',
      'uniform vec3  uWB;',
      'uniform float uContrast;',
      'uniform float uSaturation;',
      'uniform float uGreenDesat;',
      'uniform float uShadowLift;',
      'uniform float uSharpen;',
      'uniform vec2  uProtect;',
      'uniform float uVignette;',
      'uniform float uGrain;',

      'vec3 srgbToLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }',
      'vec3 linearToSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }',

      'vec3 aces(vec3 x) {',
      '  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);',
      '}',

      'vec3 rgb2hsv(vec3 c) {',
      '  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);',
      '  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));',
      '  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));',
      '  float d = q.x - min(q.w, q.y);',
      '  float e = 1.0e-10;',
      '  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);',
      '}',

      'void main() {',
      '  vec2 uv = v_textureCoordinates;',
      '  vec2 texel = 1.0 / czm_viewport.zw;',
      '  vec4 src = ' + h.tex + '(colorTexture, uv);',
      '  vec3 s0 = src.rgb;',

      // 受控锐化：强边缘不锐化，避免机身/草地交界出白边
      '  vec3 nb = (' + h.tex + '(colorTexture, uv + vec2(texel.x, 0.0)).rgb',
      '          + ' + h.tex + '(colorTexture, uv - vec2(texel.x, 0.0)).rgb',
      '          + ' + h.tex + '(colorTexture, uv + vec2(0.0, texel.y)).rgb',
      '          + ' + h.tex + '(colorTexture, uv - vec2(0.0, texel.y)).rgb) * 0.25;',
      '  float edge = length(s0 - nb);',
      '  float protect = 1.0 - smoothstep(uProtect.x, uProtect.y, edge);',
      '  vec3 c = s0 + (s0 - nb) * uSharpen * protect;',

      '  c = srgbToLinear(c) * uExposure * uWB;',

      // 草地降饱和：只打 70°~175° 色相，且要求有一定饱和度
      '  vec3 hsv = rgb2hsv(c);',
      '  float hueDeg = hsv.x * 360.0;',
      '  float mask = smoothstep(70.0, 85.0, hueDeg) * (1.0 - smoothstep(155.0, 175.0, hueDeg));',
      '  mask *= smoothstep(0.12, 0.35, hsv.y);',
      '  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));',
      '  float satScale = mix(uSaturation, uSaturation * uGreenDesat, mask);',
      '  c = mix(vec3(lum), c, satScale);',

      // 只抬黑位，不动中间调和高光
      '  c += uShadowLift * (1.0 - smoothstep(0.0, 0.18, lum));',

      '  c = aces(c);',
      '  c = (c - 0.5) * uContrast + 0.5;',

      '  vec2 dv = uv - vec2(0.5);',
      '  c *= clamp(1.0 - uVignette * dot(dv, dv) * 2.4, 0.0, 1.0);',
      '  float gn = fract(sin(dot(uv * czm_viewport.zw, vec2(12.9898, 78.233)) + czm_frameNumber) * 43758.5453);',
      '  c += (gn - 0.5) * uGrain;',

      '  ' + h.out + ' = vec4(linearToSrgb(clamp(c, 0.0, 1.0)), src.a);',
      '}'
    ].join('\n');
  }

  /* =====================================================================
   * 4. 后处理装配
   * ===================================================================== */
  function installPost(v) {
    var Ce = C(), sc = v.scene;
    if (!Ce || !Ce.PostProcessStage) return;

    if (CFG.bloom && Ce.PostProcessStageLibrary && !S.bloom) {
      S.bloom = safe(function () {
        var b = Ce.PostProcessStageLibrary.createBloomStage();
        if (!b) return null;
        b.enabled = true;
        if (b.uniforms) {
          if ('contrast' in b.uniforms) b.uniforms.contrast = 128;
          if ('brightness' in b.uniforms) b.uniforms.brightness = -0.28;
          if ('glowOnly' in b.uniforms) b.uniforms.glowOnly = false;
          if ('delta' in b.uniforms) b.uniforms.delta = 1;
          if ('sigma' in b.uniforms) b.uniforms.sigma = 3.4;
          if ('stepSize' in b.uniforms) b.uniforms.stepSize = 2;
        }
        sc.postProcessStages.add(b);
        return b;
      }) || null;
    }

    // 大气透视必须在调色之前，否则雾色会被 ACES 二次压缩
    if (CFG.xp12 && CFG.aerial && !S.degraded && !S.aerial) {
      S.aerial = safe(function () {
        var st = new Ce.PostProcessStage({
          name: 'geofs_cine_aerial',
          fragmentShader: aerialShader(Ce),
          uniforms: {
            uDensity: CFG.fogDensity,
            uFalloff: CFG.fogHeightFalloff,
            uMax: CFG.fogMax,
            uStrength: CFG.fogStrength,
            uCamHeight: 0,
            uDistScale: CFG.aerialDistance,
            uHorizon: vec3(Ce, CFG.horizonColor),
            uZenith: vec3(Ce, CFG.zenithColor),
            uFog: vec3(Ce, CFG.fogColor)
          }
        });
        sc.postProcessStages.add(st);
        return st;
      }) || null;
    }

    if (CFG.grade && !S.stage) {
      S.stage = safe(function () {
        var st = new Ce.PostProcessStage({
          name: 'geofs_cine_grade',
          fragmentShader: gradeShader(Ce),
          uniforms: {
            uExposure: CFG.exposure,
            uWB: vec3(Ce, CFG.wb),
            uContrast: CFG.contrast,
            uSaturation: CFG.saturation,
            uGreenDesat: CFG.xp12 ? CFG.greenDesat : 1.0,
            uShadowLift: CFG.xp12 ? CFG.shadowLift : 0.0,
            uSharpen: CFG.xp12 ? CFG.sharpen : 0.32,
            uProtect: new Ce.Cartesian2(CFG.protect[0], CFG.protect[1]),
            uVignette: CFG.vignette,
            uGrain: CFG.grain
          }
        });
        sc.postProcessStages.add(st);
        return st;
      }) || null;
    }
  }

  /* 把 CFG 推到现有 uniform 上（预设切换 / 参数回滚都走这里） */
  function syncUniforms() {
    var Ce = C();
    if (!Ce) return;

    if (S.aerial && S.aerial.uniforms) {
      var u = S.aerial.uniforms;
      u.uDensity = CFG.fogDensity;
      u.uFalloff = CFG.fogHeightFalloff;
      u.uMax = CFG.fogMax;
      u.uStrength = CFG.fogStrength;
      u.uDistScale = CFG.aerialDistance;
      u.uHorizon = vec3(Ce, CFG.horizonColor);
      u.uZenith = vec3(Ce, CFG.zenithColor);
      u.uFog = vec3(Ce, CFG.fogColor);
    }

    if (S.stage && S.stage.uniforms) {
      var g = S.stage.uniforms;
      g.uExposure = CFG.exposure;
      g.uWB = vec3(Ce, CFG.wb);
      g.uContrast = CFG.contrast;
      g.uSaturation = CFG.saturation;
      g.uGreenDesat = CFG.xp12 ? CFG.greenDesat : 1.0;
      g.uShadowLift = CFG.xp12 ? CFG.shadowLift : 0.0;
      g.uSharpen = CFG.xp12 ? CFG.sharpen : 0.32;
      g.uProtect = new Ce.Cartesian2(CFG.protect[0], CFG.protect[1]);
      g.uVignette = CFG.vignette;
      g.uGrain = CFG.grain;
    }

    if (S.viewer && S.viewer.scene) {
      var sc = S.viewer.scene;
      if (sc.fog && 'density' in sc.fog) sc.fog.density = CFG.nativeFogDensity;
      safe(function () { if (S.viewer.camera) S.viewer.camera.frustum.fov = CFG.fov; });
      safe(function () { if (sc.globe && 'showWaterEffect' in sc.globe) sc.globe.showWaterEffect = CFG.water; });
    }
  }

  /* 着色器炸了：关 aerial，接回原生雾，调色照常 */
  function degrade(reason) {
    if (S.degraded) return;
    S.degraded = true;
    CFG.aerial = false;
    safe(function () { if (S.aerial) S.aerial.enabled = false; });
    safe(function () {
      var sc = S.viewer && S.viewer.scene;
      if (!sc) return;
      if (sc.fog) {
        sc.fog.enabled = true;
        if ('density' in sc.fog) sc.fog.density = CFG.nativeFogDensity * 3;
      }
    });
    if (window.console && console.warn) {
      console.warn('[GeoFS Cine] aerial 已回退到原生雾，原因：' + reason);
    }
    safe(function () { updateHud(); });
  }

  function guardRender(sc) {
    if (!sc || !sc.renderError || !sc.renderError.addEventListener) return;
    safe(function () {
      sc.renderError.addEventListener(function (scene, error) {
        var msg = String((error && (error.message || error)) || '');
        if (!/shader|compile|link|program|glsl/i.test(msg)) return;
        S.errors.push(msg.slice(0, 240));
        degrade('GLSL 编译/链接失败');
      });
    });
  }

  function updateAerial() {
    if (!S.aerial || !S.aerial.uniforms) return;
    if (!S.viewer || !S.viewer.scene.camera.positionCartographic) return;
    var h = S.viewer.scene.camera.positionCartographic.height;
    S.aerial.uniforms.uCamHeight = (typeof h === 'number' && isFinite(h)) ? h : 0;
  }

  /* =====================================================================
   * 5. 云
   * ===================================================================== */
  function makeCloudTexture() {
    var cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    var x = cv.getContext('2d');
    for (var i = 0; i < 18; i++) {
      var cx = 60 + Math.random() * 136, cy = 76 + Math.random() * 104;
      var r = 28 + Math.random() * 58, a = 0.14 + Math.random() * 0.2;
      var gr = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(3) + ')');
      gr.addColorStop(0.55, 'rgba(246,249,255,' + (a * 0.55).toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(232,240,252,0)');
      x.fillStyle = gr;
      x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    }
    return cv.toDataURL('image/png');
  }

  function installClouds(v) {
    var Ce = C(), sc = v.scene;
    if (!Ce || !CFG.clouds) return;

    if (Ce.CloudCollection) {
      safe(function () {
        var cc = new Ce.CloudCollection();
        cc.show = true;
        sc.primitives.add(cc);
        S.clouds = cc; S.cloudMode = '3d';
      });
    }
    if (!S.clouds && Ce.BillboardCollection) {
      safe(function () {
        var bc = new Ce.BillboardCollection({ scene: sc });
        sc.primitives.add(bc);
        S.clouds = bc; S.cloudMode = 'sprite';
        S.cloudTex = makeCloudTexture();
      });
    }
    S.cloudAnchor = null;
    layoutClouds();
  }

  function layoutClouds() {
    var v = S.viewer, Ce = C();
    if (!v || !Ce || !S.clouds || !CFG.clouds) return;
    if (S.level >= 2) { safe(function () { S.clouds.show = false; }); return; }

    var carto = v.scene.camera.positionCartographic;
    if (!carto) return;
    if (!(carto.height > 0) || carto.height > 9000) {
      safe(function () { S.clouds.show = false; });
      return;
    }
    safe(function () { S.clouds.show = true; });

    var lon = Ce.Math.toDegrees(carto.longitude);
    var lat = Ce.Math.toDegrees(carto.latitude);
    if (S.cloudAnchor) {
      var dx = (lon - S.cloudAnchor[0]) * 111320 * Math.cos(lat * Math.PI / 180);
      var dy = (lat - S.cloudAnchor[1]) * 110540;
      if (Math.sqrt(dx * dx + dy * dy) < 3500) return;
    }
    S.cloudAnchor = [lon, lat];

    safe(function () { S.clouds.removeAll(); });

    for (var i = 0; i < CFG.cloudCount; i++) {
      var r = 900 + Math.random() * 5200;
      var a = Math.random() * Math.PI * 2;
      var dLat = (r * Math.cos(a)) / 110540;
      var dLon = (r * Math.sin(a)) / (111320 * Math.max(Math.cos(lat * Math.PI / 180), 0.2));
      var alt = 850 + Math.random() * 1800;
      var pos = Ce.Cartesian3.fromDegrees(lon + dLon, lat + dLat, alt);

      if (S.cloudMode === '3d') {
        (function (p) {
          safe(function () {
            S.clouds.add({
              position: p,
              scale: new Ce.Cartesian2(0.5 + Math.random() * 0.9, 0.4 + Math.random() * 0.6),
              maximumSize: new Ce.Cartesian2(2600, 1300),
              slice: 0.25 + Math.random() * 0.45,
              brightness: 0.85 + Math.random() * 0.25
            });
          });
        })(pos);
      } else {
        (function (p) {
          safe(function () {
            S.clouds.add({
              position: p,
              image: S.cloudTex,
              width: 420 + Math.random() * 520,
              height: 210 + Math.random() * 280,
              scaleByDistance: new Ce.NearFarScalar(2500, 1.25, 24000, 0.5),
              color: Ce.Color.WHITE.withAlpha(0.5 + Math.random() * 0.28)
            });
          });
        })(pos);
      }
    }
  }

  /* =====================================================================
   * 6. 程序化音效
   * ===================================================================== */
  function initAudio() {
    if (S.audio) { safe(function () { S.audio.ctx.resume(); }); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    var ctx = new AC();
    var master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // 风噪：过滤后的布朗噪声
    var len = Math.floor(ctx.sampleRate * 2);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) {
      var w = Math.random() * 2 - 1;
      last = last * 0.96 + w * 0.04;
      data[i] = last * 3;
    }
    var noise = ctx.createBufferSource();
    noise.buffer = buf; noise.loop = true;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.6;
    var ng = ctx.createGain(); ng.gain.value = 0;
    noise.connect(bp); bp.connect(ng); ng.connect(master);

    // 引擎：锯齿 + 方波，低通
    var o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 70;
    var o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 35;
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    var eg = ctx.createGain(); eg.gain.value = 0;
    o1.connect(lp); o2.connect(lp); lp.connect(eg); eg.connect(master);

    noise.start(); o1.start(); o2.start();

    S.audio = { ctx: ctx, master: master, ng: ng, eg: eg, o1: o1, o2: o2, lp: lp, bp: bp };
    safe(function () { ctx.resume(); });
    master.gain.setTargetAtTime(CFG.volume, ctx.currentTime, 0.5);
  }

  function updateAudio() {
    var a = S.audio;
    if (!a) return;
    var k = Math.min(S.spd / 260, 1.6);
    var t = a.ctx.currentTime;
    a.o1.frequency.setTargetAtTime(65 + k * 210, t, 0.25);
    a.o2.frequency.setTargetAtTime(32 + k * 105, t, 0.25);
    a.lp.frequency.setTargetAtTime(380 + k * 900, t, 0.25);
    a.eg.gain.setTargetAtTime(0.05 + Math.min(k, 1) * 0.16, t, 0.3);
    a.ng.gain.setTargetAtTime(0.02 + Math.min(k, 1.4) * 0.16, t, 0.3);
    a.bp.frequency.setTargetAtTime(500 + k * 1400, t, 0.3);
  }

  /* =====================================================================
   * 7. 飞行数据采样
   * ===================================================================== */
  function sampleFlight() {
    var v = S.viewer, Ce = C();
    if (!v || !Ce) return;
    var cam = v.scene.camera;
    var now = performance.now();
    var carto = cam.positionCartographic;
    if (!carto) return;

    var alt = carto.height;
    var p = cam.positionWC;

    if (S.lastPos && now > S.lastT + 40) {
      var dt = (now - S.lastT) / 1000;
      if (dt > 0.001) {
        S.spd = Ce.Cartesian3.distance(p, S.lastPos) / dt;
        S.vs = (alt - S.lastAlt) / dt;
      }
    }
    if (typeof cam.heading === 'number') {
      var hd = Ce.Math.toDegrees(cam.heading) % 360;
      if (hd < 0) hd += 360;
      S.hdg = hd;
    }
    S.lastPos = Ce.Cartesian3.clone(p);
    S.lastAlt = alt;
    S.lastT = now;
    S.alt = alt;
    S.camHeight = (typeof alt === 'number' && isFinite(alt)) ? alt : 0;
  }

  /* =====================================================================
   * 8. OSM 建筑
   * ===================================================================== */
  function osmTick() {
    if (!CFG.osm || S.level >= 3) return;
    var v = S.viewer, Ce = C();
    if (!v || !Ce || !v.scene.camera.positionCartographic) return;
    var carto = v.scene.camera.positionCartographic;
    if (!(carto.height > 0) || carto.height > CFG.maxAltOsm) return;

    var deg = 0.04;
    var lon = Ce.Math.toDegrees(carto.longitude);
    var lat = Ce.Math.toDegrees(carto.latitude);
    var gx = Math.floor(lon / deg), gy = Math.floor(lat / deg);
    var key = gx + ':' + gy;
    if (OSM.tiles.has(key) || OSM.inflight.has(key)) return;
    if (Date.now() - OSM.last < 1400) return;

    OSM.last = Date.now();
    OSM.inflight.add(key);
    var w = gx * deg, s = gy * deg, e = w + deg, n = s + deg;
    var q = '[out:json][timeout:20];way["building"](' + s + ',' + w + ',' + n + ',' + e + ');out geom;';

    fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'data=' + encodeURIComponent(q)
    })
      .then(function (r) { return r.json(); })
      .then(function (j) { buildTile(key, j && j.elements, w + deg / 2, s + deg / 2); })
      .catch(function () {})
      .then(function () { OSM.inflight.delete(key); });
  }

  function buildTile(key, els, clon, clat) {
    var v = S.viewer, Ce = C();
    if (!v || !Ce) return;
    if (!els || !els.length) {
      OSM.tiles.set(key, { key: key, ents: [], lastUsed: Date.now() });
      return;
    }

    var base = 0;
    safe(function () {
      var h = v.scene.globe.getHeight(Ce.Cartographic.fromDegrees(clon, clat));
      if (typeof h === 'number' && isFinite(h)) base = h;
    });

    var shades = ['#d9d5ca', '#cfcabd', '#c6c2b7', '#dedad0', '#bcb8ae'];
    var ents = [];
    var count = 0;

    for (var i = 0; i < els.length && count < CFG.osmMaxBuildings; i++) {
      var el = els[i];
      if (!el || el.type !== 'way' || !el.geometry || el.geometry.length < 3) continue;
      var tags = el.tags || {};
      if (tags['building:part'] === 'yes') continue;

      var h = parseFloat(tags.height);
      if (!isFinite(h) || h <= 0) {
        var lv = parseFloat(tags['building:levels']);
        h = (isFinite(lv) && lv > 0) ? lv * 3.2 : 9;
      }
      h = Math.max(3, Math.min(h, 240));

      var flat = [];
      for (var k = 0; k < el.geometry.length; k++) {
        flat.push(el.geometry[k].lon, el.geometry[k].lat);
      }
      if (flat.length < 6) continue;

      (function (flatArr, height, idx) {
        var ent = safe(function () {
          return v.entities.add({
            polygon: {
              hierarchy: new Ce.PolygonHierarchy(Ce.Cartesian3.fromDegreesArray(flatArr)),
              height: base,
              extrudedHeight: base + height,
              material: Ce.Color.fromCssColorString(shades[idx % shades.length]).withAlpha(0.96),
              outline: false
            }
          });
        });
        if (ent) { ents.push(ent); count++; }
      })(flat, h, (el.id || i) >>> 0);
    }

    OSM.tiles.set(key, { key: key, ents: ents, lastUsed: Date.now() });
    pruneTiles();
  }

  function pruneTiles() {
    if (OSM.tiles.size <= CFG.osmMaxTiles) return;
    var arr = [];
    OSM.tiles.forEach(function (t) { arr.push(t); });
    arr.sort(function (a, b) { return a.lastUsed - b.lastUsed; });
    while (arr.length > CFG.osmMaxTiles) {
      var t = arr.shift();
      if (!t) break;
      for (var i = 0; i < t.ents.length; i++) {
        (function (ent) { safe(function () { S.viewer.entities.remove(ent); }); })(t.ents[i]);
      }
      OSM.tiles.delete(t.key);
    }
  }

  function clearOsm() {
    OSM.tiles.forEach(function (t) {
      for (var i = 0; i < t.ents.length; i++) {
        (function (ent) { safe(function () { S.viewer.entities.remove(ent); }); })(t.ents[i]);
      }
    });
    OSM.tiles.clear();
  }

  /* =====================================================================
   * 9. 性能分级（绝不动分辨率）
   * ===================================================================== */
  function decideLevel() {
    var target = S.fps >= 52 ? 0 : S.fps >= 42 ? 1 : S.fps >= 32 ? 2 : 3;
    if (target === S.level) { S.levelVotes = 0; return; }

    var now = performance.now();

    // 降级（数字变大）立即生效并冷却；升级要连续 2 秒达标
    if (target > S.level) {
      if (now - S.lastLevelAt < 4000) return;
      S.level = target;
      S.lastLevelAt = now;
      S.levelVotes = 0;
      return;
    }

    S.levelVotes++;
    if (S.levelVotes < 2) return;
    S.level = target;
    S.levelVotes = 0;
    S.lastLevelAt = now;
  }

  function applyLevel() {
    if (S.level === S.appliedLevel) return;
    S.appliedLevel = S.level;

    if (S.bloom) S.bloom.enabled = CFG.bloom && S.level === 0;
    if (S.stage) S.stage.enabled = CFG.grade;
    if (S.aerial) S.aerial.enabled = CFG.xp12 && CFG.aerial && !S.degraded && S.level <= 1;
    if (S.clouds) S.clouds.show = CFG.clouds && S.level < 2;

    if (S.level >= 3) clearOsm();
    if (S.level < 2 && CFG.clouds) { S.cloudAnchor = null; layoutClouds(); }
  }

  /* =====================================================================
   * 10. HUD
   * ===================================================================== */
  var BTN_NAMES = ['grade', 'aerial', 'clouds', 'osm', 'audio', 'preset'];

  function buildHud() {
    if (!CFG.hud || S.hud) return;

    var el = document.createElement('div');
    el.style.cssText = [
      'position:fixed;left:10px;bottom:10px;z-index:2147483647;',
      'font:600 11px/1.7 ui-monospace,Menlo,Consolas,monospace;color:#9fe8b8;',
      'background:rgba(8,12,10,.66);padding:8px 10px;border-radius:9px;',
      'border:1px solid rgba(120,255,170,.18);user-select:none;',
      'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);',
      'box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:220px;'
    ].join('');

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;gap:10px;' +
      'letter-spacing:.06em;color:#e8fff0;cursor:pointer;';
    head.innerHTML = '<span>GEOFS CINE 4.2</span><span id="gfc-tag">XP12·正午</span>';

    var body = document.createElement('div');
    body.id = 'gfc-body';
    body.innerHTML =
      '<div id="gfc-a">ALT --- m · VS ---</div>' +
      '<div id="gfc-b">SPD --- kt · HDG ---°</div>' +
      '<div id="gfc-c">FPS -- · L0 · ---</div>' +
      '<div id="gfc-d" style="color:#7fb894">fog --- · err 0</div>';

    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:4px;margin-top:6px;flex-wrap:wrap';

    for (var i = 0; i < BTN_NAMES.length; i++) {
      var name = BTN_NAMES[i];
      var b = document.createElement('button');
      b.dataset.a = name;
      b.textContent = name === 'grade' ? '调色'
        : name === 'aerial' ? '大气'
          : name === 'clouds' ? '云'
            : name === 'osm' ? '建筑'
              : name === 'audio' ? '音频'
                : '预设';
      b.style.cssText = 'all:unset;cursor:pointer;padding:2px 7px;border-radius:4px;' +
        'background:rgba(120,255,170,.16);color:#c9ffdc;font-size:11px;line-height:1.5;';
      bar.appendChild(b);
    }

    el.appendChild(head);
    el.appendChild(body);
    el.appendChild(bar);

    // 点击标题折叠；双击恢复默认参数
    head.addEventListener('click', function () {
      body.style.display = body.style.display === 'none' ? '' : 'none';
      bar.style.display = body.style.display === 'none' ? 'none' : 'flex';
    });
    head.addEventListener('dblclick', function (ev) {
      ev.stopPropagation();
      resetCfg();
    });

    el.addEventListener('click', function (ev) {
      var b = ev.target;
      if (!b || !b.dataset || !b.dataset.a) return;
      var a = b.dataset.a;
      var v = S.viewer;
      if (!v) return;

      if (a === 'grade') {
        CFG.grade = !CFG.grade;
        if (S.stage) S.stage.enabled = CFG.grade;
        saveCfg(); updateHud();
      } else if (a === 'aerial') {
        if (S.degraded) {
          // 已经因着色器失败回退过：再点只切原生雾开关
          CFG.aerial = false;
          var sc0 = v.scene;
          if (sc0.fog) sc0.fog.enabled = !sc0.fog.enabled;
          updateHud();
          return;
        }
        CFG.aerial = !CFG.aerial;
        CFG.xp12 = CFG.aerial;
        if (S.aerial) S.aerial.enabled = CFG.aerial;
        if (v.scene.fog) {
          v.scene.fog.enabled = !CFG.aerial;
          if ('density' in v.scene.fog) {
            v.scene.fog.density = CFG.aerial ? CFG.nativeFogDensity : CFG.nativeFogDensity * 3;
          }
        }
        syncUniforms();
        saveCfg(); updateHud();
      } else if (a === 'clouds') {
        CFG.clouds = !CFG.clouds;
        if (S.clouds) S.clouds.show = CFG.clouds;
        if (CFG.clouds) { S.cloudAnchor = null; layoutClouds(); }
        saveCfg(); updateHud();
      } else if (a === 'osm') {
        CFG.osm = !CFG.osm;
        if (!CFG.osm) clearOsm();
        saveCfg(); updateHud();
      } else if (a === 'audio') {
        initAudio();
        if (S.audio) {
          var on = S.audio.master.gain.value > 0.001;
          S.audio.master.gain.setTargetAtTime(on ? 0 : CFG.volume, S.audio.ctx.currentTime, 0.2);
          updateHud();
        }
      } else if (a === 'preset') {
        var idx = PRESET_ORDER.indexOf(CFG.preset);
        applyPreset(PRESET_ORDER[(idx + 1) % PRESET_ORDER.length]);
      }
    });

    document.body.appendChild(el);
    S.hud = el;
    updateHud();
  }

  function updateHud() {
    if (!S.hud) return;

    var a = S.hud.querySelector('#gfc-a');
    var b = S.hud.querySelector('#gfc-b');
    var c = S.hud.querySelector('#gfc-c');
    var d = S.hud.querySelector('#gfc-d');
    var tag = S.hud.querySelector('#gfc-tag');

    var kt = S.spd * 1.94384;
    var vs = S.vs;

    if (a) a.textContent = 'ALT ' + Math.round(S.alt) + ' m · VS ' + (vs >= 0 ? '+' : '') + vs.toFixed(1);
    if (b) b.textContent = 'SPD ' + Math.round(kt) + ' kt · HDG ' + String(Math.round(S.hdg)).padStart(3, '0') + '°';
    if (c) {
      c.textContent = 'FPS ' + S.fps + ' · L' + S.level + ' · ' + (S.cloudMode === '3d' ? 'CLD3D' : S.cloudMode === 'sprite' ? 'CLD2D' : 'CLD--');
    }
    if (d) {
      d.textContent = 'fog ' + (S.degraded ? 'native' : (CFG.aerial ? 'aerial' : 'off')) +
        ' · err ' + S.errors.length;
      d.style.color = S.degraded ? '#e8b46a' : '#7fb894';
    }
    if (tag) {
      tag.textContent = (S.degraded ? '标准' : 'XP12') + '·' + (PRESET_LABEL[CFG.preset] || '自定义');
    }

    var btns = S.hud.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var name = btns[i].dataset.a;
      var on = true;
      if (name === 'grade') on = CFG.grade;
      else if (name === 'aerial') on = CFG.aerial && !S.degraded;
      else if (name === 'clouds') on = CFG.clouds;
      else if (name === 'osm') on = CFG.osm;
      else if (name === 'audio') on = !!(S.audio && S.audio.master.gain.value > 0.001);
      btns[i].style.opacity = on ? '1' : '.38';
    }
  }

  function applyPreset(name) {
    var p = PRESETS[name];
    if (!p) return;

    // 预设是"整组快照"：先回默认，再叠加差异，切回正午才真的还原
    var k;
    for (k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) CFG[k] = cloneVal(DEFAULTS[k]);
    }
    for (k in p) {
      if (Object.prototype.hasOwnProperty.call(p, k)) CFG[k] = cloneVal(p[k]);
    }
    CFG.preset = name;

    CFG.aerial = true;
    CFG.xp12 = true;
    S.degraded = false;

    if (!S.aerial && S.viewer) installPost(S.viewer);
    if (S.aerial) S.aerial.enabled = true;
    if (S.stage) S.stage.enabled = CFG.grade;
    if (S.viewer && S.viewer.scene.fog) S.viewer.scene.fog.enabled = false;

    syncUniforms();
    saveCfg();
    updateHud();
  }

  function resetCfg() {
    applyPreset('noon');
  }

  /* =====================================================================
   * 11. 主循环
   * ===================================================================== */
  var lastT = performance.now(), frames = 0;

  function loop(ts) {
    requestAnimationFrame(loop);
    frames++;
    if (ts - lastT < 1000) return;

    S.fps = Math.round(frames * 1000 / (ts - lastT));
    frames = 0; lastT = ts;

    decideLevel();
    applyLevel();
    layoutClouds();
    updateHud();
  }

  /* =====================================================================
   * 12. 诊断
   * ===================================================================== */
  window.geofsCineInfo = function () {
    var v = S.viewer || getViewer();
    if (!v) return 'viewer 未就绪';
    var sc = v.scene, g = sc.globe, Ce = C();
    var tiles = 0, bld = 0;
    OSM.tiles.forEach(function (t) { tiles++; bld += t.ents.length; });

    return {
      version: '4.2.0',
      cesium: Ce ? Ce.VERSION : 'window.Cesium 缺失',
      canvas: sc.canvas ? sc.canvas.width + 'x' + sc.canvas.height : null,
      dpr: window.devicePixelRatio,
      resolutionScale: v.resolutionScale,
      fovDeg: Math.round(v.camera.frustum.fov * 180 / Math.PI),
      fps: S.fps,
      level: S.level,
      preset: CFG.preset,
      xp12: CFG.xp12,
      bloom: !!(S.bloom && S.bloom.enabled),
      grade: !!(S.stage && S.stage.enabled),
      aerial: !!(S.aerial && S.aerial.enabled),
      fogMode: S.degraded ? 'native' : (CFG.aerial ? 'aerial' : 'off'),
      depthTexture: !!(sc.context && sc.context.depthTexture),
      errors: S.errors.slice(0, 5),
      cloudMode: S.cloudMode,
      cloudVisible: !!(S.clouds && S.clouds.show),
      waterEffect: g && g.showWaterEffect,
      hasShadowMap: !!sc.shadowMap,
      osmTiles: tiles,
      osmBuildings: bld,
      audio: !!S.audio,
      alt: Math.round(S.alt),
      spdKt: Math.round(S.spd * 1.94384)
    };
  };

  window.geofsCineSet = function (key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return '未知参数：' + key;
    CFG[key] = value;
    CFG.preset = 'custom';
    syncUniforms();
    saveCfg();
    updateHud();
    return true;
  };

  window.geofsCinePreset = function (name) {
    if (PRESET_ORDER.indexOf(name) < 0) return '可选：' + PRESET_ORDER.join(' / ');
    applyPreset(name);
    return true;
  };

  /* =====================================================================
   * 13. 启动
   * ===================================================================== */
  function boot(v) {
    S.viewer = v;
    applyCore(v);
    guardRender(v.scene);
    installPost(v);
    installClouds(v);
    buildHud();
    updateAerial();

    if (!S.started) {
      S.started = true;
      requestAnimationFrame(loop);
      setInterval(function () {
        sampleFlight();
        updateAudio();
        updateHud();
        updateAerial();
      }, 200);
      setInterval(osmTick, 900);
      setInterval(function () {
        var nv = getViewer();
        if (nv && nv !== S.viewer) {
          S.viewer = nv;
          S.bloom = null; S.stage = null; S.aerial = null; S.clouds = null;
          S.appliedLevel = -1;
          OSM.tiles.clear();
          applyCore(nv);
          guardRender(nv.scene);
          installPost(nv);
          installClouds(nv);
        }
      }, 3000);
    }
  }

  var wait = setInterval(function () {
    var v = getViewer();
    if (!v || !v.scene || !v.scene.globe) return;
    clearInterval(wait);
    boot(v);
  }, 450);
})();
