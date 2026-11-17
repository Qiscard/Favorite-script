// ==UserScript==
// @name         PikPak 分享下载助手
// @namespace    https://github.com/Qiscard/Favorite-script
// @version      0.7.1
// @description  扫描 PikPak 分享目录并获取直链，推送到 aria2 按原目录结构下载，支持在线播放、单文件下载与列表导出
// @author       Qiscard
// @license      MIT
// @homepageURL  https://github.com/Qiscard/Favorite-script
// @supportURL   https://github.com/Qiscard/Favorite-script/issues
// @updateURL    https://raw.githubusercontent.com/Qiscard/Favorite-script/main/ScriptCat/PikPak分享下载助手.user.js
// @downloadURL  https://raw.githubusercontent.com/Qiscard/Favorite-script/main/ScriptCat/PikPak分享下载助手.user.js
// @icon         data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📥</text></svg>
// @match        https://mypikpak.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        GM_addStyle
// @grant        window.onurlchange
// @connect      api-drive.mypikpak.com
// @connect      user.mypikpak.com
// @connect      *.mypikpak.com
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* ==UserConfig==
aria2:
  rpcUrl:
    title: aria2 RPC 地址
    description: aria2c --enable-rpc 开启的 JSON-RPC 地址
    type: text
    default: "http://127.0.0.1:6800/jsonrpc"
  secret:
    title: RPC 密钥
    description: 对应 --rpc-secret，未设置可留空
    type: text
    password: true
    default: ""
  proxy:
    title: aria2 代理
    description: aria2 访问 PikPak/CDN 用的代理，需与浏览器一致
    type: text
    default: ""
  savePath:
    title: 保存根目录
    description: 下载根目录，分享内的目录结构会保留
    type: text
    default: "D:/PikPak"
media:
  preferTranscoding:
    title: 优先转码
    description: 原画为 AV1/HEVC 播放不了时，优先取兼容性更好的转码流
    type: checkbox
    default: false
==/UserConfig== */



(function () {
  'use strict';

  // ---------------------------------------------------------------- 常量
  const API = 'https://api-drive.mypikpak.com';
  const NON_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
  // 单文件浏览器下载：≤ 此大小的文件走内存转存（保证文件名正确），更大走 chrome.downloads
  const BLOB_NAMED_LIMIT = 200 * 1024 * 1024;
  const STANDARD_DAILY_LIMIT_BYTES = 20 * 1024 * 1024 * 1024;
  const CDN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
  const MEDIA_EXTS = new Set([
    '3gp', 'asf', 'avi', 'av1', 'flac', 'flv', 'gif', 'heic', 'heif', 'jpeg', 'jpg',
    'm2ts', 'm4a', 'm4v', 'mkv', 'mov', 'mp3', 'mp4', 'mpeg', 'mpg', 'ogg', 'opus',
    'png', 'rm', 'rmvb', 'ts', 'webm', 'webp', 'wmv', 'wav',
  ]);
  const ARIA2_FIELDS = [
    'status', 'completedLength', 'totalLength', 'downloadSpeed', 'connections',
    'errorCode', 'errorMessage', 'numPieces', 'pieceLength', 'files',
  ];
  const BROWSER_DOWNLOAD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

  // 多套客户端凭证（clientId + clientVersion + packageName + 对应 salt 组）。
  // PikPak 更新会使某一套 captcha_sign 算法失效；这里按顺序探测，哪套通就锁定哪套，
  // 单点失效仍有备份。移植自 crl/huangguo 的多 profile 故障转移。
  // 顺序：新版 android → web → 旧版 android（本项目已验证）。
  const PROFILES = [
    {
      name: 'android-1.53.2',
      clientId: 'YNxT9w7GMdWvEOKa',
      clientVersion: '1.53.2',
      packageName: 'com.pikcloud.pikpak',
      salts: [
        'SOP04dGzk0TNO7t7t9ekDbAmx+eq0OI1ovEx', 'nVBjhYiND4hZ2NCGyV5beamIr7k6ifAsAbl',
        'Ddjpt5B/Cit6EDq2a6cXgxY9lkEIOw4yC1GDF28KrA', 'VVCogcmSNIVvgV6U+AochorydiSymi68YVNGiz',
        'u5ujk5sM62gpJOsB/1Gu/zsfgfZO', 'dXYIiBOAHZgzSruaQ2Nhrqc2im',
        'z5jUTBSIpBN9g4qSJGlidNAutX6', 'KJE2oveZ34du/g1tiimm',
      ],
    },
    {
      name: 'web-2.0.0',
      clientId: 'YUMx5nI8ZU8Ap8pm',
      clientVersion: '2.0.0',
      packageName: 'mypikpak.com',
      salts: [
        'C9qPpZLN8ucRTaTiUMWYS9cQvWOE', '+r6CQVxjzJV6LCV', 'F', 'pFJRC',
        '9WXYIDGrwTCz2OiVlgZa90qpECPD6olt', '/750aCr4lm/Sly/c', 'RB+DT/gZCrbV', '',
        'CyLsf7hdkIRxRm215hl', '7xHvLi2tOYP0Y92b', 'ZGTXXxu8E/MIWaEDB+Sm/', '1UI3',
        'E7fP5Pfijd+7K+t6Tg/NhuLq0eEUVChpJSkrKxpO', 'ihtqpG6FMt65+Xk+tWUH2', 'NhXXU9rg4XXdzo7u5o',
      ],
    },
    {
      name: 'android-1.47.1',
      clientId: 'YNxT9w7GMdWvEOKa',
      clientVersion: '1.47.1',
      packageName: 'com.pikcloud.pikpak',
      salts: [
        'Gez0T9ijiI9WCeTsKSg3SMlx', 'zQdbalsolyb1R/', 'ftOjr52zt51JD68C3s',
        'yeOBMH0JkbQdEFNNwQ0RI9T3wU/v', 'BRJrQZiTQ65WtMvwO', 'je8fqxKPdQVJiy1DM6Bc9Nb1',
        'niV', '9hFCW2R1', 'sHKHpe2i96', 'p7c5E6AcXQ/IJUuAEC9W6', '',
        'aRv9hjc9P+Pbn+u3krN6', 'BzStcgE8qVdqjEH16l4', 'SqgeZvL5j9zoHP95xWHt',
        'zVof5yaJkPe3VFpadPof',
      ],
    },
  ];
  // 当前锁定的 profile（establishProfile 探测后设定）
  let ACTIVE = PROFILES[0];

  // ---------------------------------------------------------------- MD5（自包含）
  function md5(str) {
    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function cmn(q, a, b, x, s, t) { return rl(((q + a + x + t) | 0), s) + b | 0; }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
    function binl2hex(binarray) {
      const hex = '0123456789abcdef';
      let s = '';
      for (let i = 0; i < binarray.length * 4; i++) {
        s += hex.charAt((binarray[i >> 2] >> ((i % 4) * 8 + 4)) & 15) +
             hex.charAt((binarray[i >> 2] >> ((i % 4) * 8)) & 15);
      }
      return s;
    }
    const s2a = unescape(encodeURIComponent(str));
    const nblk = ((s2a.length + 8) >> 6) + 1;
    const blks = new Array(nblk * 16).fill(0);
    for (let i = 0; i < s2a.length; i++) blks[i >> 2] |= s2a.charCodeAt(i) << ((i % 4) * 8);
    blks[s2a.length >> 2] |= 0x80 << ((s2a.length % 4) * 8);
    blks[nblk * 16 - 2] = s2a.length * 8;
    let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (let i = 0; i < blks.length; i += 16) {
      const [oa, ob, oc, od] = [a, b, c, d];
      a = ff(a, b, c, d, blks[i + 0], 7, -680876936);   d = ff(d, a, b, c, blks[i + 1], 12, -389564586);
      c = ff(c, d, a, b, blks[i + 2], 17, 606105819);   b = ff(b, c, d, a, blks[i + 3], 22, -1044525330);
      a = ff(a, b, c, d, blks[i + 4], 7, -176418897);   d = ff(d, a, b, c, blks[i + 5], 12, 1200080426);
      c = ff(c, d, a, b, blks[i + 6], 17, -1473231341); b = ff(b, c, d, a, blks[i + 7], 22, -45705983);
      a = ff(a, b, c, d, blks[i + 8], 7, 1770035416);   d = ff(d, a, b, c, blks[i + 9], 12, -1958414417);
      c = ff(c, d, a, b, blks[i + 10], 17, -42063);     b = ff(b, c, d, a, blks[i + 11], 22, -1990404162);
      a = ff(a, b, c, d, blks[i + 12], 7, 1804603682);  d = ff(d, a, b, c, blks[i + 13], 12, -40341101);
      c = ff(c, d, a, b, blks[i + 14], 17, -1502002290);b = ff(b, c, d, a, blks[i + 15], 22, 1236535329);
      a = gg(a, b, c, d, blks[i + 1], 5, -165796510);   d = gg(d, a, b, c, blks[i + 6], 9, -1069501632);
      c = gg(c, d, a, b, blks[i + 11], 14, 643717713);  b = gg(b, c, d, a, blks[i + 0], 20, -373897302);
      a = gg(a, b, c, d, blks[i + 5], 5, -701558691);   d = gg(d, a, b, c, blks[i + 10], 9, 38016083);
      c = gg(c, d, a, b, blks[i + 15], 14, -660478335); b = gg(b, c, d, a, blks[i + 4], 20, -405537848);
      a = gg(a, b, c, d, blks[i + 9], 5, 568446438);    d = gg(d, a, b, c, blks[i + 14], 9, -1019803690);
      c = gg(c, d, a, b, blks[i + 3], 14, -187363961);  b = gg(b, c, d, a, blks[i + 8], 20, 1163531501);
      a = gg(a, b, c, d, blks[i + 13], 5, -1444681467); d = gg(d, a, b, c, blks[i + 2], 9, -51403784);
      c = gg(c, d, a, b, blks[i + 7], 14, 1735328473);  b = gg(b, c, d, a, blks[i + 12], 20, -1926607734);
      a = hh(a, b, c, d, blks[i + 5], 4, -378558);      d = hh(d, a, b, c, blks[i + 8], 11, -2022574463);
      c = hh(c, d, a, b, blks[i + 11], 16, 1839030562); b = hh(b, c, d, a, blks[i + 14], 23, -35309556);
      a = hh(a, b, c, d, blks[i + 1], 4, -1530992060);  d = hh(d, a, b, c, blks[i + 4], 11, 1272893353);
      c = hh(c, d, a, b, blks[i + 7], 16, -155497632);  b = hh(b, c, d, a, blks[i + 10], 23, -1094730640);
      a = hh(a, b, c, d, blks[i + 13], 4, 681279174);   d = hh(d, a, b, c, blks[i + 0], 11, -358537222);
      c = hh(c, d, a, b, blks[i + 3], 16, -722521979);  b = hh(b, c, d, a, blks[i + 6], 23, 76029189);
      a = hh(a, b, c, d, blks[i + 9], 4, -640364487);   d = hh(d, a, b, c, blks[i + 12], 11, -421815835);
      c = hh(c, d, a, b, blks[i + 15], 16, 530742520);  b = hh(b, c, d, a, blks[i + 2], 23, -995338651);
      a = ii(a, b, c, d, blks[i + 0], 6, -198630844);   d = ii(d, a, b, c, blks[i + 7], 10, 1126891415);
      c = ii(c, d, a, b, blks[i + 14], 15, -1416354905);b = ii(b, c, d, a, blks[i + 5], 21, -57434055);
      a = ii(a, b, c, d, blks[i + 12], 6, 1700485571);  d = ii(d, a, b, c, blks[i + 3], 10, -1894986606);
      c = ii(c, d, a, b, blks[i + 10], 15, -1051523);   b = ii(b, c, d, a, blks[i + 1], 21, -2054922799);
      a = ii(a, b, c, d, blks[i + 8], 6, 1873313359);   d = ii(d, a, b, c, blks[i + 15], 10, -30611744);
      c = ii(c, d, a, b, blks[i + 6], 15, -1560198380); b = ii(b, c, d, a, blks[i + 13], 21, 1309151649);
      a = ii(a, b, c, d, blks[i + 4], 6, -145523070);   d = ii(d, a, b, c, blks[i + 11], 10, -1120210379);
      c = ii(c, d, a, b, blks[i + 2], 15, 718787259);   b = ii(b, c, d, a, blks[i + 9], 21, -343485551);
      a = (a + oa) | 0; b = (b + ob) | 0; c = (c + oc) | 0; d = (d + od) | 0;
    }
    return binl2hex([a, b, c, d]);
  }

  // ---------------------------------------------------------------- 工具
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function gmXhr(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        timeout: 30000,
        ...opts,
        onload: resolve,
        onerror: (detail) => {
          const error = new Error('网络错误(可能被拦截): ' + opts.url);
          error.details = detail;
          reject(error);
        },
        ontimeout: () => reject(new Error('请求超时: ' + opts.url)),
      });
    });
  }

  function humanSize(n) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
  }

  // 文件名净化：去掉控制字符、替换 Windows 非法字符、去尾部点/空格、
  // 处理 Windows 保留名（CON/NUL/COM1...），限长。
  function sanitize(s) {
    let name = String(s || 'untitled')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[.\s]+$/, '')
      .slice(0, 180);
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = '_' + name;
    return name || 'untitled';
  }

  // ---------------------------------------------------------------- 页面请求捕获：跟踪用户当前浏览的目录
  // 分享 URL 的 "AAAA..." 段是加密引用无法解析；页面进入子目录时会调
  // share/detail?parent_id=<真实id>，从页面自己的请求里捕获当前目录。
  // 注意：脚本运行在隔离上下文，必须用 unsafeWindow 修补页面真实窗口；
  // 另用 PerformanceObserver 兜底（资源时间线按 frame 共享，不受隔离影响）。
  const pageWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const nav = { shareId: '', parentId: '', pagePct: '' };

  function recordPageReq(u) {
    try {
      const url = new URL(u, location.href);
      if (url.hostname !== 'api-drive.mypikpak.com') return;
      const sid = url.searchParams.get('share_id');
      if (!sid) return;
      // 换了分享必须连 pagePct 一起清掉，否则旧分享的 pass_code_token 会串到新分享
      if (sid !== nav.shareId) { nav.shareId = sid; nav.parentId = ''; nav.pagePct = ''; }
      const pid = url.searchParams.get('parent_id');
      const pct = url.searchParams.get('pass_code_token');
      if (pid) nav.parentId = pid;
      if (pct) nav.pagePct = pct;
    } catch { /* ignore */ }
  }

  function hookPageRequests() {
    // 1) 修补页面真实窗口的 fetch / XHR
    try {
      if (!pageWin.__pph_hooked) {
        pageWin.__pph_hooked = true;
        const of = pageWin.fetch;
        if (of) {
          pageWin.fetch = function (...a) {
            try { recordPageReq(typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || ''); } catch { /* ignore */ }
            return of.apply(this, a);
          };
        }
        const oo = pageWin.XMLHttpRequest.prototype.open;
        pageWin.XMLHttpRequest.prototype.open = function (m, u) {
          try { recordPageReq(String(u)); } catch { /* ignore */ }
          return oo.apply(this, arguments);
        };
      }
    } catch { /* ignore */ }
    // 2) PerformanceObserver（buffered 会回放页面已发出的请求）
    try {
      pageWin.performance.setResourceTimingBufferSize(4096);
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) recordPageReq(e.name);
      }).observe({ type: 'resource', buffered: true });
    } catch { /* ignore */ }
  }

  // 兜底：直接扫资源时间线（不依赖任何钩子是否生效）
  function detectParentFromPerf(shareId) {
    try {
      const entries = pageWin.performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i].name || '';
        if (name.includes('/drive/v1/share/detail')) {
          recordPageReq(name);
        }
      }
    } catch { /* ignore */ }
    return nav.shareId === shareId ? nav.parentId : '';
  }

  // ---------------------------------------------------------------- PikPak API 客户端
  const deviceId = (() => {
    let id = GM_getValue('device_id', '');
    if (!id) { id = crypto.randomUUID().replace(/-/g, ''); GM_setValue('device_id', id); }
    return id;
  })();

  const captchaCache = new Map(); // "auth|profile|action" -> {token, expireAt}

  // ---------------------------------------------------------------- 登录态（自动读取）
  // PikPak 网页端把登录凭证存在 credentials_<clientId> 中。只读取 token 元数据，
  // 不把 token 写入日志或 GM 存储；网页刷新 token 后下一次 API 调用会自动跟随。
  function parseExpiry(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const n = Number(trimmed);
        return n < 1e12 ? n * 1000 : n;
      }
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  function readAuth() {
    try {
      const keys = Object.keys(pageWin.localStorage)
        .filter((key) => /^credentials_/.test(key))
        .sort((a, b) => {
          const preferred = 'credentials_' + ACTIVE.clientId;
          return a === preferred ? -1 : b === preferred ? 1 : 0;
        });
      for (const key of keys) {
        try {
          const raw = pageWin.localStorage.getItem(key);
          const credentials = JSON.parse(raw || '{}');
          const token = credentials && credentials.access_token;
          if (typeof token !== 'string' || !token.trim()) continue;
          const expiresAt = parseExpiry(credentials.expires_at);
          if (expiresAt && expiresAt <= Date.now()) continue;
          return {
            token,
            clientId: key.replace(/^credentials_/, ''),
            userId: typeof credentials.sub === 'string' ? credentials.sub : '',
            expiresAt,
          };
        } catch {
          // 一个损坏的 credentials 项不应阻塞后续凭证项。
        }
      }
    } catch {
      // localStorage 不可读时静默降级为匿名。
    }
    return null;
  }

  let AUTH = null;
  let AUTH_REJECTED = '';
  function authFingerprint(auth) {
    return auth ? `${auth.clientId}|${auth.userId}|${auth.token.slice(0, 12)}` : 'anonymous';
  }
  function refreshAuth() {
    const candidate = readAuth();
    const candidateFingerprint = authFingerprint(candidate);
    const next = candidateFingerprint !== AUTH_REJECTED ? candidate : null;
    if (authFingerprint(next) !== authFingerprint(AUTH)) captchaCache.clear();
    AUTH = next;
    return AUTH;
  }

  function captchaSign(profile, ts) {
    let sign = profile.clientId + profile.clientVersion + profile.packageName + deviceId + ts;
    for (const salt of profile.salts) sign = md5(sign + salt);
    return '1.' + sign;
  }

  async function captchaToken(action, force) {
    refreshAuth();
    const key = `${authFingerprint(AUTH)}|${ACTIVE.name}|${action}`;
    if (!force) {
      const hit = captchaCache.get(key);
      if (hit && hit.expireAt > Date.now()) return hit.token;
    }
    const ts = String(Date.now());
    const body = {
      client_id: ACTIVE.clientId, action, device_id: deviceId,
      meta: {
        captcha_sign: captchaSign(ACTIVE, ts), client_version: ACTIVE.clientVersion,
        package_name: ACTIVE.packageName, user_id: (AUTH && AUTH.userId) || '', timestamp: ts,
      },
    };
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-Device-Id': deviceId, 'X-Client-Id': ACTIVE.clientId };
    if (AUTH) headers.Authorization = 'Bearer ' + AUTH.token;
    const resp = await gmXhr({
      method: 'POST', url: 'https://user.mypikpak.com/v1/shield/captcha/init',
      headers,
      data: JSON.stringify(body),
    });
    let j;
    try { j = JSON.parse(resp.responseText); } catch { throw new Error('captcha/init 响应解析失败'); }
    if (resp.status !== 200 || !j.captcha_token) {
      const desc = j.error_description || j.error || resp.responseText.slice(0, 120);
      const err = new Error('captcha/init 失败(' + resp.status + '): ' + desc);
      err.error = j.error;
      err.errorCode = Number.isFinite(Number(j.error_code)) ? Number(j.error_code) : undefined;
      err.statusCode = resp.status;
      throw err;
    }
    captchaCache.set(key, { token: j.captcha_token, expireAt: Date.now() + 280e3 });
    return j.captcha_token;
  }

  async function apiGet(path, params, action) {
    const qs = new URLSearchParams(params).toString();
    const url = API + path + '?' + qs;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      refreshAuth();
      const token = await captchaToken(action, attempt > 0);
      const headers = { 'X-Device-Id': deviceId, 'X-Client-Id': ACTIVE.clientId, 'X-Captcha-Token': token };
      if (AUTH) headers.Authorization = 'Bearer ' + AUTH.token;
      let resp;
      try {
        resp = await gmXhr({ method: 'GET', url, headers });
      } catch (error) {
        lastError = error;
        if (attempt < 2) { await sleep(300 * (attempt + 1)); continue; }
        throw error;
      }
      let j;
      try { j = JSON.parse(resp.responseText); } catch { throw new Error(path + ' 响应解析失败'); }
      const code = Number.isFinite(Number(j.error_code)) ? Number(j.error_code) : 0;
      const hasError = Boolean(j.error) || (j.error_code !== undefined && code !== 0);
      if (resp.status >= 200 && resp.status < 300 && !hasError) return j;

      const authFailure = resp.status === 401 || resp.status === 403 || code === 16 || /unauthenticated|invalid auth|token expired/i.test(`${j.error || ''} ${j.error_description || ''}`);
      const retryable = code === 9 || authFailure || resp.status === 429 || (resp.status >= 500 && resp.status <= 599);
      const desc = j.error_description || j.error || j.details?.[0]?.detail || '未知错误';
      const error = new Error(path + ' ' + resp.status + ': ' + desc);
      error.error = j.error;
      error.errorCode = code || undefined;
      error.statusCode = resp.status;
      lastError = error;
      if (!retryable || attempt >= 2) throw error;

      if (authFailure) {
        const previous = authFingerprint(AUTH);
        refreshAuth();
        if (authFingerprint(AUTH) === previous) {
          AUTH_REJECTED = previous;
          AUTH = null;
        }
      }
      captchaCache.clear();
      await sleep(300 * (attempt + 1));
    }
    throw lastError || new Error(path + ' 请求失败');
  }

  const shareInfo = (shareId, passCode) => {
    const p = { share_id: shareId, thumbnail_size: 'SIZE_LARGE', limit: '100', order: '3' };
    if (passCode) p.pass_code = passCode;
    return apiGet('/drive/v1/share', p, 'GET:/drive/v1/share');
  };

  // 探测哪套 profile 能通：依次用每套凭证请求 share，成功即锁定并持久化。
  // 上次成功的 profile 会排到最前，避免每次都从头试。
  async function establishProfile(shareId, passCode) {
    refreshAuth();
    // 已登录：token 的 aud 就是某套 clientId，直接用匹配的 profile（无需轮询）
    if (AUTH) {
      const matched = PROFILES.find((p) => p.clientId === AUTH.clientId);
      ACTIVE = matched || PROFILES.find((p) => p.name === 'web-2.0.0') || PROFILES[0];
      try {
        const info = await shareInfo(shareId, passCode);
        log('已登录（' + (AUTH.userId || '用户') + '），凭证 ' + ACTIVE.name + '；非媒体文件可直链下载');
        return info;
      } catch (error) {
        // apiGet 判定为认证失败时已把 AUTH 置空。若这里 AUTH 仍有值，
        // 或错误本就不是认证类（401/403/错误码16），说明与登录无关，直接抛出；
        // 只有"登录态确实失效"才降级为匿名继续探测。
        const authFailure = [401, 403].includes(error.statusCode) || error.errorCode === 16;
        if (AUTH || !authFailure) throw error;
        log('登录态已失效，媒体文件改用匿名模式；非媒体文件请重新登录后再试');
      }
    }
    const saved = GM_getValue('active_profile', '');
    const order = [...PROFILES].sort((a, b) => (a.name === saved ? -1 : b.name === saved ? 1 : 0));
    let lastErr = new Error('无可用凭证');
    for (const profile of order) {
      ACTIVE = profile;
      try {
        const info = await shareInfo(shareId, passCode);
        // 能拿到响应即说明 captcha_sign 被接受（含需要提取码的状态）
        if (saved !== profile.name) { GM_setValue('active_profile', profile.name); }
        if (profile !== PROFILES[0] || saved !== profile.name) log('已锁定凭证: ' + profile.name);
        return info;
      } catch (e) {
        lastErr = e;
        // 凭证/签名类错误才继续换下一套；其它错误（如网络）直接抛出
        if (e.errorCode === 9 || /captcha|sign|shield|invalid/i.test(e.message)) {
          log('凭证 ' + profile.name + ' 不通，换下一套…');
          continue;
        }
        throw e;
      }
    }
    ACTIVE = PROFILES[0];
    throw lastErr;
  }

  async function listFolder(shareId, pctToken, parentId) {
    const params = {
      share_id: shareId, pass_code_token: pctToken, limit: '100',
      thumbnail_size: 'SIZE_LARGE', order: '6', folders_first: 'true',
    };
    if (parentId) params.parent_id = parentId;
    const files = [];
    let pageToken = '';
    for (;;) {
      if (pageToken) params.page_token = pageToken;
      const j = await apiGet('/drive/v1/share/detail', params, 'GET:/drive/v1/share/detail');
      files.push(...(j.files || []));
      pageToken = j.next_page_token || '';
      if (!pageToken) return files;
    }
  }

  function fileExtension(file) {
    const raw = file?.file_extension || file?.name || '';
    const name = String(raw).toLowerCase();
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1) : '';
  }

  function isMediaFile(file) {
    const mime = String(file?.mime_type || '').toLowerCase();
    return /^(video|audio|image)\//.test(mime) || MEDIA_EXTS.has(fileExtension(file));
  }

  // 可在线播放（视频/音频）：图片不进播放器
  function isStreamable(file) {
    const mime = String(file?.mime_type || '').toLowerCase();
    if (/^video\//.test(mime) || /^audio\//.test(mime)) return true;
    if (/^image\//.test(mime)) return false;
    return ['3gp', 'asf', 'avi', 'flac', 'flv', 'm2ts', 'm4a', 'm4v', 'mkv', 'mov', 'mp3',
      'mpeg', 'mpg', 'ogg', 'opus', 'rm', 'rmvb', 'ts', 'wav', 'webm', 'wmv']
      .includes(fileExtension(file));
  }

  function nonMediaLimitError(file) {
    const size = Number(file?.size || 0);
    if (!isMediaFile(file) && size >= NON_MEDIA_MAX_BYTES) {
      const error = new Error(`非媒体文件仅支持小于 100 MB（当前 ${humanSize(size)}）`);
      error.code = 'NON_MEDIA_LIMIT';
      return error;
    }
    return null;
  }

  function extractLink(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value.url === 'string') return value.url;
    return '';
  }

  function urlExpireAt(url) {
    try {
      const value = Number(new URL(url).searchParams.get('expire') || 0);
      return value > 0 ? value * 1000 : 0;
    } catch {
      return 0;
    }
  }

  // 取文件直链。媒体默认原画；非媒体优先登录态下的 web_content_link。
  async function resolveUrl(shareId, pctToken, fileId, fileMeta, preferTranscoding) {
    const limitError = nonMediaLimitError(fileMeta);
    if (limitError) throw limitError;
    refreshAuth();
    if (!isMediaFile(fileMeta) && !AUTH) {
      const error = new Error('非媒体文件需要先登录 PikPak；匿名模式只能下载媒体文件');
      error.code = 'AUTH_REQUIRED_NON_MEDIA';
      throw error;
    }

    const params = { share_id: shareId, pass_code_token: pctToken, file_id: fileId };
    const first = await apiGet('/drive/v1/share/file_info', params, 'GET:/drive/v1/share/file_info');
    const collect = (j) => {
      const info = j.file_info || {};
      const medias = (info.medias || []).filter((m) => extractLink(m?.link));
      const candidates = [];
      const seen = new Set();
      const push = (url, source) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        candidates.push({ url, source, expireAt: urlExpireAt(url) });
      };
      const origin = (m) => m.is_origin === true || m.category === 'original' || /(?:^|[?&])category=original(?:&|$)/i.test(extractLink(m?.link));
      const transcoded = (m) => !origin(m) && (m.category === 'transcoded' || /(?:^|[?&])(?:category=transcoded|t=1)(?:&|$)/i.test(extractLink(m?.link)));
      const nonMedia = !isMediaFile(fileMeta) && !isMediaFile(info);
      if (nonMedia) {
        push(extractLink(info.web_content_link), 'web_content_link');
        for (const [mime, value] of Object.entries(info.links || {})) push(extractLink(value), mime === 'application/octet-stream' ? 'octet-stream' : 'link:' + mime);
      }
      if (preferTranscoding) for (const media of medias) if (transcoded(media)) push(extractLink(media.link), 'transcoded');
      for (const media of medias) if (origin(media)) push(extractLink(media.link), 'original');
      if (!nonMedia) {
        push(extractLink(info.web_content_link), 'web_content_link');
        for (const [mime, value] of Object.entries(info.links || {})) push(extractLink(value), mime === 'application/octet-stream' ? 'octet-stream' : 'link:' + mime);
      }
      for (const media of medias) push(extractLink(media.link), transcoded(media) ? 'transcoded' : 'media');
      return candidates;
    };

    let candidates = collect(first);
    if (!candidates.length) {
      const fetched = await apiGet('/drive/v1/share/file_info', { ...params, usage: 'FETCH' }, 'GET:/drive/v1/share/file_info');
      candidates = collect(fetched);
    }
    const selected = candidates.find((candidate) => !candidate.expireAt || candidate.expireAt > Date.now() + CDN_REFRESH_MARGIN_MS);
    if (!selected) {
      const error = new Error('下载直链为空或已过期；请重新获取直链');
      error.code = 'NO_VALID_URL';
      throw error;
    }
    return selected;
  }

  // ---------------------------------------------------------------- 扫描器
  const SCAN_CP_KEY = 'scanCheckpoint';

  // BFS 递归扫描。单个目录失败重试一次后跳过并记录，不再整体作废；
  // 中止/失败时把剩余队列与已得结果存入 GM，下次“扫描全部(递归)”可从断点继续。
  async function scanTree(shareId, pctToken, rootId, onProgress, state, seed) {
    const queue = (seed && seed.queue.length) ? seed.queue : [{ id: rootId, path: '' }];
    const results = seed ? seed.results : [];
    const errors = seed ? seed.errors : [];
    let dirsDone = seed ? seed.dirsDone : 0;
    while (queue.length) {
      if (state.aborted) break;
      const { id, path } = queue.shift();
      let items = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          items = await listFolder(shareId, pctToken, id);
          break;
        } catch (e) {
          if (e.error === 'file_not_found') break;
          if (attempt === 0) { await sleep(800); continue; }
          errors.push({ path: path || '（扫描起点）', message: e.message || String(e) });
        }
      }
      if (items) {
        for (const f of items) {
          const p = path + '/' + sanitize(f.name);
          if (f.kind === 'drive#folder') queue.push({ id: f.id, path: p });
          else results.push({ path: p, file: f });
        }
      }
      dirsDone++;
      onProgress && onProgress(dirsDone, queue.length, results.length);
      await sleep(300); // 节流，避免触发风控
    }
    if (state.aborted || queue.length) {
      // 未扫完：存断点（下次从剩余队列继续）
      GM_setValue(SCAN_CP_KEY, { shareId, rootId, dirsDone, queue, results, errors, savedAt: Date.now() });
    } else {
      GM_deleteValue(SCAN_CP_KEY); // 全部扫完，清除断点
    }
    return { results, errors, aborted: state.aborted };
  }

  // 只保留取链需要的字段，用于持久化扫描结果
  function slimFile(f) {
    return { id: f.id, name: f.name, size: f.size, mime_type: f.mime_type, file_extension: f.file_extension, kind: f.kind };
  }

  function persistLastScan() {
    if (!state.shareId) return;
    const files = state.entries.filter((e) => e.file).slice(0, 5000)
      .map((e) => ({ path: e.path, file: slimFile(e.file), selected: e.selected !== false }));
    GM_setValue('lastScan', { shareId: state.shareId, title: state.title, savedAt: Date.now(), files });
  }

  function restoreLastScan() {
    const ls = GM_getValue('lastScan');
    if (!ls || ls.shareId !== state.shareId || !(ls.files || []).length) return log('没有可恢复的扫描结果（或属于别的分享）');
    state.entries = ls.files.map((e) => ({ path: e.path, file: e.file, selected: e.selected !== false }));
    if (ls.title) state.title = ls.title;
    log(`已恢复上次扫描（${state.entries.length} 个文件，保存于 ${new Date(ls.savedAt).toLocaleString()}）；直链会按需重新获取`);
    renderList(visibleEntries());
    updateActionButtons();
  }

  // 点击文件夹条目：直接列出该目录内容，不必回分享页双击
  async function scanInto(entry) {
    if (state.busy || !entry || !entry.folderId) return;
    setBusy(true);
    try {
      const items = await listFolder(state.shareId, state.pctToken, entry.folderId);
      state.dirStack.push({ id: entry.folderId, path: entry.path });
      state.entries = items.map((f) => f.kind === 'drive#folder'
        ? { path: entry.path + '/' + sanitize(f.name), file: null, folderId: f.id }
        : { path: entry.path + '/' + sanitize(f.name), file: f });
      log(`已进入目录: ${entry.path}（${state.entries.filter((e) => e.file).length} 个文件）`);
      renderList(visibleEntries());
      updateActionButtons();
    } catch (e) {
      log('进入目录失败: ' + (e.message || e), true);
    } finally {
      setBusy(false);
    }
  }

  // 返回上一级目录
  async function scanUp() {
    if (state.busy) return;
    if (state.dirStack.length <= 1) return log('已经在扫描起点目录');
    state.dirStack.pop();
    const parent = state.dirStack[state.dirStack.length - 1];
    setBusy(true);
    try {
      const items = await listFolder(state.shareId, state.pctToken, parent.id);
      const base = parent.path || '';
      state.entries = items.map((f) => f.kind === 'drive#folder'
        ? { path: base + '/' + sanitize(f.name), file: null, folderId: f.id }
        : { path: base + '/' + sanitize(f.name), file: f });
      log(`返回上级: ${base || '（起点）'}`);
      renderList(visibleEntries());
      updateActionButtons();
    } catch (e) {
      log('返回上级失败: ' + (e.message || e), true);
    } finally {
      setBusy(false);
    }
  }

  // file_info 请求节流：并发取链时共用；遇到 429/限流指数退避，成功后缓慢回落。
  const urlThrottle = { ms: 250 };

  // 懒取直链：失败可重试；签名 URL 接近过期时自动刷新。
  async function ensureUrl(entry, force = false) {
    if (!entry || !entry.file) return false;
    const hardLimit = nonMediaLimitError(entry.file);
    if (hardLimit) {
      entry.error = hardLimit.message;
      entry.errorCode = hardLimit.code;
      return false;
    }
    const validCached = entry.url && (!entry.urlExpireAt || entry.urlExpireAt > Date.now() + CDN_REFRESH_MARGIN_MS);
    if (!force && validCached) return true;
    if (!force && entry.errorCode === 'NON_MEDIA_LIMIT') return false;
    entry.url = null;
    entry.urlSource = '';
    entry.urlExpireAt = 0;
    entry.error = null;
    entry.errorCode = '';
    refreshAuth();
    try {
      const resolved = await resolveUrl(state.shareId, state.pctToken, entry.file.id, entry.file, cfg.preferTranscoding);
      entry.url = resolved.url;
      entry.urlSource = resolved.source;
      entry.urlExpireAt = resolved.expireAt;
      entry.error = null;
      entry.errorCode = '';
      urlThrottle.ms = Math.max(250, urlThrottle.ms - 50); // 成功则缓慢恢复
      return true;
    } catch (e) {
      entry.error = e.message || String(e);
      entry.errorCode = e.code || e.errorCode || '';
      // 触发限流：加长所有取链请求的间隔
      if (e.statusCode === 429 || e.errorCode === 8 || /too many|rate|RESOURCE_EXHAUSTED/i.test(e.message || '')) {
        urlThrottle.ms = Math.min(5000, urlThrottle.ms * 2 + 250);
        log(`取链被限流，请求间隔调整为 ${urlThrottle.ms}ms`);
      }
      return false;
    } finally {
      await sleep(urlThrottle.ms);
    }
  }

  // ---------------------------------------------------------------- aria2 RPC
  const aria2Tasks = new Map();
  let aria2MonitorRunning = false;

  async function aria2Call(rpcUrl, secret, method, params) {
    const requestId = 'pph-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const body = { jsonrpc: '2.0', id: requestId, method, params: secret ? ['token:' + secret, ...params] : params };
    let resp;
    try {
      resp = await gmXhr({
        method: 'POST', url: rpcUrl,
        headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error('无法连接 aria2 RPC（' + rpcUrl + '）：' + (e.message || '连接失败'));
    }
    if (resp.status < 200 || resp.status >= 300) throw new Error('aria2 RPC HTTP ' + resp.status + '：请检查 RPC 地址、代理和跨域设置');
    let j;
    try { j = JSON.parse(resp.responseText); } catch { throw new Error('aria2 响应异常(HTTP ' + resp.status + ')'); }
    if (j.error) {
      const m = j.error.message || '';
      if (/Unauthorized/i.test(m)) throw new Error('aria2 认证失败：RPC 密钥不匹配（检查 --rpc-secret 与脚本设置）');
      throw new Error('aria2 错误 ' + (j.error.code ?? '') + '：' + (m || '未知错误'));
    }
    if (!Object.prototype.hasOwnProperty.call(j, 'result')) throw new Error('aria2 响应缺少 result');
    return j.result;
  }

  function aria2Options(entry, snapshot) {
    // 保存目录为空时 dir 会拼成 "/子目录" 这样的相对路径，aria2 会落到自己的工作目录
    const saveRoot = String(snapshot.savePath || '').trim();
    if (!saveRoot) throw new Error('请先在面板或 ScriptCat 设置中填写保存目录');
    const slash = entry.path.lastIndexOf('/');
    const relativeDir = slash > 0 ? entry.path.slice(0, slash) : '';
    const dir = saveRoot.replace(/[\\/]+$/, '') + relativeDir;
    const out = entry.path.slice(slash + 1);
    const options = {
      dir,
      out,
      split: '8',
      'max-connection-per-server': '8',
      'min-split-size': '4M',
      continue: 'true',
      'max-tries': '5',
      'retry-wait': '5',
      timeout: '30',
      'connect-timeout': '30',
      'file-allocation': 'none',
      'auto-file-renaming': 'false',
      header: [
        'Referer: https://mypikpak.com/',
        'Accept: */*',
        'User-Agent: ' + BROWSER_DOWNLOAD_UA,
      ],
    };
    if (snapshot.proxy) options['all-proxy'] = snapshot.proxy;
    return { options, out };
  }

  function ariaStatusText(status) {
    return ({ active: '下载中', waiting: '排队中', paused: '已暂停', complete: '✓ 完成', error: '✗ 失败', removed: '已移除' })[status] || status || '未知';
  }

  // 收集 aria2 当前活动/排队任务的目标文件路径，用于推送去重（重复推送会因
  // auto-file-renaming=false + 文件已存在而报错）。查询失败不阻塞推送。
  async function getAria2KnownPaths(rpcUrl, secret) {
    const paths = new Set();
    try {
      const active = await aria2Call(rpcUrl, secret, 'aria2.tellActive', [['files']]);
      for (const st of active || []) for (const f of st.files || []) if (f.path) paths.add(f.path.replace(/\\/g, '/'));
      const waiting = await aria2Call(rpcUrl, secret, 'aria2.tellWaiting', [0, 500, ['files']]);
      for (const st of waiting || []) for (const f of st.files || []) if (f.path) paths.add(f.path.replace(/\\/g, '/'));
    } catch { /* ignore */ }
    return paths;
  }

  function ensureAriaTaskRow(entry, gid) {
    if (!aria2TasksEl) return null;
    const row = document.createElement('div');
    row.className = 'task';
    const title = document.createElement('span');
    title.className = 'nm';
    title.textContent = entry.path;
    const status = document.createElement('span');
    status.className = 'st';
    status.textContent = '已入队 · GID ' + gid;
    row.append(title, document.createTextNode(' '), status);
    aria2TasksEl.prepend(row);
    while (aria2TasksEl.children.length > 12) aria2TasksEl.lastChild.remove();
    return { row, status };
  }

  function updateAriaTask(task, info) {
    if (!task || !task.status) return;
    const status = String(info.status || 'unknown');
    const done = Number(info.completedLength || 0);
    const total = Number(info.totalLength || task.expectedSize || 0);
    const speed = Number(info.downloadSpeed || 0);
    const connections = Number(info.connections || 0);
    if (status === 'complete') {
      // 完成时核对实际大小与分享列表大小：CDN 返回错误页被当成文件存下来时二者会不符
      const expected = Number(task.expectedSize || 0);
      let mismatch = '';
      if (expected > 0 && total > 0 && Math.abs(total - expected) / expected > 0.01) {
        mismatch = ` ⚠ 大小不符（期望 ${humanSize(expected)}），建议删除后重新推送`;
      }
      task.status.textContent = `✓ 完成 · ${humanSize(total || done)}${mismatch}`;
    } else if (status === 'error') {
      task.status.textContent = `✗ ${info.errorMessage || ('错误码 ' + (info.errorCode || 'unknown'))}`;
    } else {
      const progress = total > 0 ? ` · ${((done / total) * 100).toFixed(1)}%` : '';
      task.status.textContent = `${ariaStatusText(status)} · ${humanSize(done)} / ${humanSize(total)}${progress} · ${humanSize(speed)}/s · ${connections} 连接`;
    }
  }

  function startAria2Monitor() {
    if (aria2MonitorRunning) return;
    aria2MonitorRunning = true;
    const tick = async () => {
      const tasks = [...aria2Tasks.values()].filter((task) => !task.terminal);
      if (!tasks.length) { aria2MonitorRunning = false; return; }
      await Promise.all(tasks.map(async (task) => {
        try {
          const info = await aria2Call(task.rpcUrl, task.secret, 'aria2.tellStatus', [task.gid, ARIA2_FIELDS]);
          updateAriaTask(task, info);
          if (String(info.status) === 'error' && !task.retried && task.multiConn) {
            // 多连接被 CDN/代理拒绝是常见失败原因：自动改单连接重推一次
            void retryTaskSingle(task);
          } else if (['complete', 'error', 'removed'].includes(String(info.status))) {
            task.terminal = true;
            const oldGid = task.gid;
            setTimeout(() => aria2Tasks.delete(oldGid), 30_000);
          }
        } catch (error) {
          task.status.textContent = '监控失败：' + (error.message || error);
        }
      }));
      if (aria2Tasks.size) setTimeout(tick, 1000);
      else aria2MonitorRunning = false;
    };
    void tick();
  }

  // aria2 任务失败后的一次性自动重推：强制重新取链（直链可能已过期）+ 单连接
  async function retryTaskSingle(task) {
    task.retried = true;
    task.status.textContent = '✗ 失败 → 单连接重推中…';
    const entry = task.entry;
    const name = entry ? entry.path.split('/').pop() : task.gid;
    log(`aria2 任务失败，重新取链并单连接重推: ${name}`);
    try { await aria2Call(task.rpcUrl, task.secret, 'aria2.remove', [task.gid]); } catch { /* ignore */ }
    aria2Tasks.delete(task.gid);
    if (!entry) {
      task.terminal = true;
      task.status.textContent = '✗ 失败（无法自动重推，请检查 aria2 代理与直链有效期）';
      return;
    }
    const ok = await ensureUrl(entry, true);
    if (!ok || !entry.url) {
      task.terminal = true;
      task.status.textContent = '✗ 重推失败: ' + (entry.error || '取链失败');
      log(`单连接重推失败: ${name} — ${entry.error || '取链失败'}`, true);
      return;
    }
    try {
      const built = aria2Options(entry, task.snapshot);
      built.options.split = '1';
      built.options['max-connection-per-server'] = '1';
      const gid = await aria2Call(task.rpcUrl, task.secret, 'aria2.addUri', [[entry.url], built.options]);
      if (typeof gid !== 'string' || !gid) throw new Error('aria2 未返回任务 GID');
      task.gid = gid;
      aria2Tasks.set(gid, task);
      task.terminal = false;
      task.status.textContent = '已入队 · 单连接 · GID ' + gid;
      log(`单连接重推已入队: ${name}`);
    } catch (err) {
      task.terminal = true;
      task.status.textContent = '✗ 单连接重推失败（请检查代理/RPC/直链）';
      log(`单连接重推失败: ${name} — ${err.message || err}`, true);
    }
  }

  // ---------------------------------------------------------------- 配置
  // 配置同时暴露在两处：ScriptCat 的 ==UserConfig== 设置表单（键为 "组.键"）和面板输入框，
  // 读写同一存储键。v0.6.x 使用的无前缀旧键在首次读取时自动迁移。
  const CFG_LEGACY = {
    'aria2.rpcUrl': 'rpcUrl',
    'aria2.secret': 'secret',
    'aria2.proxy': 'aria2Proxy',
    'aria2.savePath': 'savePath',
    'media.preferTranscoding': 'preferTranscoding',
  };

  function cfgGet(key, fallback) {
    let v = GM_getValue(key);
    if (v === undefined || v === null) {
      const legacyKey = CFG_LEGACY[key];
      if (legacyKey) {
        const old = GM_getValue(legacyKey);
        if (old !== undefined && old !== null) {
          GM_setValue(key, old);
          return old;
        }
      }
      return fallback;
    }
    return v;
  }

  const cfg = {
    get rpcUrl() { return cfgGet('aria2.rpcUrl', 'http://127.0.0.1:6800/jsonrpc'); },
    set rpcUrl(v) { GM_setValue('aria2.rpcUrl', v); },
    get secret() { return String(cfgGet('aria2.secret', '')); },
    set secret(v) { GM_setValue('aria2.secret', v); },
    get proxy() { return String(cfgGet('aria2.proxy', '')); },
    set proxy(v) { GM_setValue('aria2.proxy', v); },
    get savePath() { return String(cfgGet('aria2.savePath', 'D:/PikPak')); },
    set savePath(v) { GM_setValue('aria2.savePath', v); },
    get preferTranscoding() { return Boolean(cfgGet('media.preferTranscoding', false)); },
    set preferTranscoding(v) { GM_setValue('media.preferTranscoding', Boolean(v)); },
  };

  // ---------------------------------------------------------------- UI
  GM_addStyle(`
    #pph-btn{position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#3b82f6;color:#fff;border:none;
      border-radius:8px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35)}
    #pph-btn:hover{background:#2563eb}
    #pph-panel{position:fixed;right:16px;bottom:60px;z-index:2147483647;width:460px;max-height:84vh;overflow:auto;
      background:#0f172a;color:#e2e8f0;border-radius:12px;font-size:13px;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      box-shadow:0 8px 32px rgba(0,0,0,.5);display:none}
    /* 头部 */
    #pph-head{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#1e293b;
      border-radius:12px 12px 0 0;position:sticky;top:0;z-index:2}
    #pph-head .ttl{font-size:14px;font-weight:600;color:#93c5fd;flex:1}
    #pph-head .ver{font-size:11px;font-weight:400;color:#64748b}
    #pph-head .x{cursor:pointer;color:#94a3b8;font-size:18px;line-height:1;padding:0 4px}
    #pph-head .x:hover{color:#f87171}
    /* 登录状态条 */
    #pph-auth{display:flex;align-items:center;gap:8px;margin:10px 14px 0;padding:8px 10px;
      border-radius:8px;background:#1e293b;font-size:12px}
    #pph-auth .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
    #pph-auth .dot.on{background:#22c55e;box-shadow:0 0 6px #22c55e}
    #pph-auth .dot.off{background:#f59e0b}
    #pph-auth .txt{flex:1;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #pph-auth button{padding:3px 8px;font-size:11px}
    #pph-notice{margin:10px 14px 0;padding:10px 12px;border-radius:8px;background:#172554;
      border:1px solid #1d4ed8;color:#dbeafe;font-size:11px;line-height:1.55}
    #pph-notice ul{margin:5px 0 0;padding-left:18px}
    #pph-notice li{margin:2px 0}
    #pph-notice .warn{color:#fde68a}
    #pph-notice .ok{color:#bbf7d0}
    /* 分区 */
    .pph-sec{margin:10px 14px 0;padding:10px;background:#1e293b;border-radius:8px}
    .pph-sec .hd{font-size:11px;color:#64748b;margin-bottom:6px;letter-spacing:.5px}
    #pph-panel button{background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:6px 11px;
      margin:2px 4px 2px 0;cursor:pointer;font-size:12px}
    #pph-panel button:hover{filter:brightness(1.1)}
    #pph-panel button.sec{background:#475569}
    #pph-panel button:disabled{opacity:.5;cursor:not-allowed}
    #pph-panel input[type=text],#pph-panel input:not([type]){background:#0f172a;color:#e2e8f0;border:1px solid #334155;
      border-radius:5px;padding:5px 7px;font-size:12px}
    #pph-field{display:flex;align-items:center;gap:8px;margin:5px 0}
    #pph-field label{width:72px;flex-shrink:0;color:#94a3b8;font-size:12px}
    #pph-field input{flex:1;min-width:0}
    #pph-stat{margin:8px 14px 0;color:#93c5fd;font-size:12px;min-height:16px}
    #pph-list{margin:8px 14px 0;max-height:220px;overflow:auto;background:#1e293b;border-radius:8px}
    #pph-list .row{display:flex;gap:8px;padding:5px 10px;border-bottom:1px solid #0f172a;align-items:center}
    #pph-list .row:last-child{border-bottom:none}
    #pph-list .row:hover{background:#334155}
    #pph-list .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #pph-list .sz{color:#94a3b8;flex-shrink:0;font-size:11px}
    #pph-list a{color:#93c5fd;text-decoration:none;flex-shrink:0;cursor:pointer;padding:0 2px}
    #pph-list a:hover{color:#bfdbfe;text-decoration:underline}
    #pph-dltasks,#pph-aria2tasks{margin:8px 14px 0}
    #pph-dltasks .task,#pph-aria2tasks .task{display:flex;gap:8px;align-items:center;margin:4px 0;padding:6px 8px;background:#1e293b;border-radius:6px;font-size:12px;color:#cbd5e1}
    #pph-dltasks .nm,#pph-aria2tasks .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #pph-dltasks .st,#pph-aria2tasks .st{color:#93c5fd;flex-shrink:0}
    #pph-log{white-space:pre-wrap;word-break:break-all;background:#020617;border-radius:8px;color:#94a3b8;
      padding:8px 10px;max-height:130px;overflow:auto;margin:8px 14px 0;line-height:1.5;font-family:monospace;font-size:11px}
    #pph-foot{color:#475569;font-size:11px;padding:10px 14px 14px;line-height:1.5}
    .pph-red{background:#dc2626 !important}
    .pph-chk{display:flex;align-items:center;gap:6px;color:#94a3b8;font-size:12px;margin:5px 0}
    .pph-chk input{width:14px;height:14px}
    /* v0.7.0 新增 */
    #pph-panel select{background:#0f172a;color:#e2e8f0;border:1px solid #334155;
      border-radius:5px;padding:5px 7px;font-size:12px}
    #pph-list .row input[type=checkbox]{flex-shrink:0;margin:0 2px;accent-color:#3b82f6}
    #pph-list .row .nm.dir{cursor:pointer;color:#93c5fd}
    #pph-progress{height:6px;border-radius:3px;background:#1e293b;margin:8px 14px 0;overflow:hidden;display:none}
    #pph-progress .bar{height:100%;width:0;background:#3b82f6;transition:width .2s}
    #pph-logbar{display:flex;align-items:center;margin:8px 14px 0;font-size:11px;color:#64748b}
    #pph-logbar a{margin-left:auto;color:#93c5fd;cursor:pointer;flex-shrink:0}
    #pph-logbar a:hover{color:#bfdbfe}
    #pph-log{margin:4px 14px 0}
    /* 在线播放：提示与播放器 */
    #pph-toast{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:2147483647;
      background:rgba(15,23,42,.94);color:#e2e8f0;border:1px solid #334155;border-radius:8px;
      padding:10px 16px;font-size:13px;max-width:70vw;box-shadow:0 4px 16px rgba(0,0,0,.4);
      opacity:0;transition:opacity .25s;pointer-events:none}
    #pph-toast.show{opacity:1}
    #pph-toast.err{color:#fecaca;border-color:#7f1d1d}
    #pph-player{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.72);display:none;
      align-items:center;justify-content:center}
    #pph-player.open{display:flex}
    .pph-pv{width:min(920px,94vw);background:#0f172a;border-radius:12px;overflow:hidden;
      box-shadow:0 12px 48px rgba(0,0,0,.6)}
    .pph-pv-head{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#1e293b}
    .pph-pv-head .t{flex:1;color:#93c5fd;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pph-pv-head .x{cursor:pointer;color:#94a3b8;font-size:18px;line-height:1;padding:0 4px}
    .pph-pv-head .x:hover{color:#f87171}
    .pph-pv video{width:100%;max-height:70vh;background:#000;display:block}
    .pph-pv-tip{padding:8px 14px;color:#fbbf24;font-size:12px;display:none;line-height:1.6}
    .pph-pv-tip a{color:#93c5fd;cursor:pointer}
    /* 亮色主题：跟随系统 */
    @media (prefers-color-scheme: light) {
      #pph-panel{background:#f8fafc;color:#1e293b;box-shadow:0 8px 32px rgba(0,0,0,.18)}
      #pph-head{background:#e2e8f0}
      #pph-head .ttl{color:#1d4ed8}
      #pph-head .ver{color:#94a3b8}
      #pph-auth{background:#e2e8f0}
      #pph-auth .txt{color:#334155}
      #pph-notice{background:#dbeafe;border-color:#93c5fd;color:#1e3a8a}
      .pph-sec{background:#e2e8f0}
      .pph-sec .hd{color:#64748b}
      #pph-panel input[type=text],#pph-panel input:not([type]),#pph-panel select{background:#fff;color:#1e293b;border-color:#cbd5e1}
      #pph-list{background:#e2e8f0}
      #pph-list .row{border-bottom-color:#f1f5f9}
      #pph-list .row:hover{background:#cbd5e1}
      #pph-list .sz{color:#64748b}
      #pph-list a,#pph-logbar a{color:#1d4ed8}
      #pph-dltasks .task,#pph-aria2tasks .task{background:#e2e8f0;color:#334155}
      #pph-dltasks .st,#pph-aria2tasks .st,#pph-stat{color:#1d4ed8}
      #pph-log{background:#fff;color:#475569}
      #pph-progress{background:#e2e8f0}
      #pph-foot{color:#64748b}
      #pph-panel button.sec{background:#94a3b8}
      #pph-chk{color:#475569}
      #pph-toast{background:rgba(255,255,255,.97);color:#1e293b;border-color:#cbd5e1;box-shadow:0 4px 16px rgba(0,0,0,.15)}
      #pph-toast.err{color:#b91c1c;border-color:#fca5a5}
      .pph-pv{background:#f8fafc}
      .pph-pv-head{background:#e2e8f0}
    }
  `);

  let panel, logEl, listEl, statEl, abortBtn, dlTasksEl, aria2TasksEl, authEl;
  const state = {
    shareId: '', pctToken: null, rootId: '', title: '',
    entries: [], aborted: false, busy: false,
    scanErrors: [],      // 递归扫描中跳过的目录 [{path, message}]
    dirStack: [],        // 非递归浏览的目录链 [{id, path}]，支持"进入/返回上级"
    passCode: '',        // 面板提取码输入框内容
  };

  const LOG_MAX_LINES = 400;
  function log(msg, isError) {
    if (!logEl) return;
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = document.createElement('div');
    if (isError) line.style.color = '#f87171';
    line.textContent = `[${t}] ${msg}`;
    logEl.append(line);
    while (logEl.children.length > LOG_MAX_LINES) logEl.firstChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setBusy(b) {
    state.busy = b;
    panel.querySelectorAll('button:not(#pph-abort), input').forEach((el) => (el.disabled = b));
    abortBtn.disabled = !b;
  }

  // 批量进度条：传 0~1 显示，传 null 隐藏
  function setProgress(frac) {
    const el = panel && panel.querySelector('#pph-progress');
    if (!el) return;
    if (frac == null) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.querySelector('.bar').style.width = Math.max(0, Math.min(100, frac * 100)) + '%';
  }

  function currentShareId() {
    const m = location.pathname.match(/\/s\/([^/]+)/);
    return m ? m[1] : '';
  }

  function extAllowed(name, filter) {
    if (!filter.trim()) return true;
    const ext = (name.split('.').pop() || '').toLowerCase();
    return filter.split(',').map((s) => s.trim().toLowerCase().replace(/^\./, '')).includes(ext);
  }

  function filteredEntries() {
    return state.entries.filter((e) => !e.file || extAllowed(e.path, panel.querySelector('#pph-ext').value));
  }

  // 列表实际显示的条目：扩展名过滤 + 名称搜索 + 排序
  function visibleEntries() {
    let list = filteredEntries();
    const q = (panel.querySelector('#pph-search').value || '').trim().toLowerCase();
    if (q) list = list.filter((e) => e.path.toLowerCase().includes(q));
    const sortBy = panel.querySelector('#pph-sort').value;
    if (sortBy === 'name') list = [...list].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
    else if (sortBy === 'size') list = [...list].sort((a, b) => Number(b.file?.size || 0) - Number(a.file?.size || 0));
    return list;
  }

  // 当前会被推送/导出的文件：可见 + 已勾选
  function selectedTargets() {
    return visibleEntries().filter((e) => e.file && e.selected !== false);
  }

  function updateActionButtons() {
    if (!panel) return;
    const n = selectedTargets().length;
    const set = (sel, label) => { const b = panel.querySelector(sel); if (b) b.textContent = `${label} (${n})`; };
    set('#pph-dl', '推送 aria2');
    set('#pph-exp2', '导出列表');
    set('#pph-txt', '导出URL');
    const up = panel.querySelector('#pph-up');
    if (up) up.disabled = state.busy || state.dirStack.length <= 1;
  }

  function renderList(entries) {
    listEl.innerHTML = '';
    const shown = entries.slice(0, 300);
    for (const e of shown) {
      const row = document.createElement('div');
      row.className = 'row';
      const isFolder = !e.file;
      if (!isFolder) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = e.selected !== false;
        cb.title = '勾选后才会被推送/导出';
        cb.onchange = () => { e.selected = cb.checked; updateActionButtons(); };
        row.append(cb);
      }
      const nm = document.createElement('span');
      nm.className = 'nm' + (isFolder ? ' dir' : '');
      nm.textContent = (isFolder ? '📁 ' : '') + (e.error ? '✗ ' + e.path : e.path);
      if (e.error) nm.style.color = '#f87171';
      nm.title = e.path;
      const sz = document.createElement('span');
      sz.className = 'sz';
      if (isFolder) {
        // 点击文件夹名或"进入"直接扫描该目录，不必回页面双击
        nm.onclick = () => scanInto(e);
        const go = document.createElement('a');
        go.textContent = '进入';
        go.onclick = () => scanInto(e);
        row.append(nm, sz, go);
      } else {
        const size = Number(e.file.size || 0);
        const restricted = nonMediaLimitError(e.file);
        sz.textContent = humanSize(size) + (restricted ? ' · 非媒体>100MB' : (!isMediaFile(e.file) ? ' · 需登录' : ''));
        if (restricted) sz.style.color = '#fbbf24';
        const dl = document.createElement('a');
        dl.textContent = '下载';
        dl.onclick = () => downloadSingle(e);
        const cp = document.createElement('a');
        cp.textContent = '复制';
        cp.onclick = async () => {
          cp.textContent = '…';
          const ok = await ensureUrl(e);
          cp.textContent = '复制';
          renderList(visibleEntries());
          if (!ok || !e.url) return log('取链失败: ' + e.path.split('/').pop() + ' — ' + (e.error || '无可用直链'), true);
          GM_setClipboard(e.url);
          log('已复制直链: ' + e.path.split('/').pop());
        };
        if (isStreamable(e.file)) {
          const play = document.createElement('a');
          play.textContent = '播放';
          play.title = '在线播放（不下载）';
          play.onclick = () => playMedia(e);
          row.append(nm, sz, play, dl, cp);
        } else {
          row.append(nm, sz, dl, cp);
        }
      }
      listEl.append(row);
    }
    if (entries.length > 300) {
      const more = document.createElement('div');
      more.className = 'row';
      more.textContent = `…共 ${entries.length} 项，仅显示前 300（可用搜索缩小范围）`;
      listEl.append(more);
    }
  }

  // 内存转存下载：GM_xhr 取回 Blob 后用 <a download> 落盘。
  // blob URL 的 download 属性不会被跨域忽略，文件名一定正确；
  // 直连 <a download> 跨域会被忽略，CDN 又不返回 Content-Disposition，Chrome 只能命名"下载"。
  function blobDownloadNamed(url, name, st, setAbort) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok, message) => {
        if (settled) return;
        settled = true;
        resolve({ ok, message });
      };
      try {
        const req = GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'blob',
          timeout: 30 * 60 * 1000,
          headers: { Referer: 'https://mypikpak.com/' },
          onprogress: (d) => {
            const total = Number(d.total || d.totalSize || 0);
            const done = Number(d.loaded || d.done || 0);
            if (total > 0) st.textContent = `${humanSize(done)} / ${humanSize(total)} (${((done / total) * 100).toFixed(1)}%)`;
            else if (done > 0) st.textContent = humanSize(done);
          },
          onload: (resp) => {
            try {
              if (resp.status !== 200) return finish(false, 'HTTP ' + resp.status);
              const blob = resp.response;
              if (!blob) return finish(false, '响应为空');
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = name;
              document.body.append(a);
              a.click();
              setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 30000);
              finish(true, '✓ 完成');
            } catch (err) {
              finish(false, String(err && err.message || err));
            }
          },
          onerror: () => finish(false, '网络错误'),
          ontimeout: () => finish(false, '下载超时'),
        });
        if (setAbort) setAbort(() => { try { req.abort(); } catch { /* ignore */ } });
      } catch (err) {
        finish(false, String(err && err.message || err));
      }
    });
  }

  // 单文件下载：
  //   ≤200MB → 内存转存（文件名保证正确）；>200MB → GM_download browser（chrome.downloads 直写盘）。
  //   失败时清直链重取重试一次；仍失败才交给浏览器 <a> 兜底（文件名可能不正确）。
  function downloadSingle(e) {
    if (state.busy || e.downloading) return;
    const relPath = e.path.replace(/^\//, '');
    const name = relPath.split('/').pop();
    const size = Number(e.file?.size || 0);
    const run = async () => {
      e.downloading = true;
      const box = document.createElement('div');
      box.className = 'task';
      const label = document.createElement('span');
      label.className = 'nm';
      label.textContent = relPath;
      const st = document.createElement('span');
      st.className = 'st';
      st.textContent = '准备中…';
      let handle = null;      // GM_download 句柄
      let abortXhr = null;    // 内存转存的中止函数
      let canceled = false;
      const cancel = document.createElement('a');
      cancel.textContent = '取消';
      cancel.onclick = () => {
        canceled = true;
        try {
          if (handle && typeof handle.abort === 'function') handle.abort();
          else if (typeof handle === 'function') handle();
          if (abortXhr) abortXhr();
        } catch { /* ignore */ }
        st.textContent = '已取消';
        cancel.remove();
      };
      box.append(label, document.createTextNode(' '), st, cancel);
      dlTasksEl.prepend(box);
      if (dlTasksEl.children.length > 12) dlTasksEl.lastChild.remove();

      const fallback = (reason) => {
        if (canceled) return;
        st.textContent = '已交给浏览器（请查看下载栏）';
        log('直接浏览器下载: ' + name + (reason ? '（' + reason + '）' : '') + '；注意：此兜底路径文件名可能不正确，建议改用 aria2', true);
        const a = document.createElement('a');
        a.href = e.url;
        a.download = name;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.append(a);
        a.click();
        setTimeout(() => a.remove(), 1000);
      };

      const attempt = (retry) => new Promise((resolve) => {
        let settled = false;
        const finish = (ok, message) => {
          if (settled) return;
          settled = true;
          cancel.remove();
          resolve({ ok, message });
        };
        try {
          const h = GM_download({
            url: e.url,
            name: relPath,
            downloadMode: 'browser',
            saveAs: false,
            conflictAction: 'uniquify',
            onprogress: (d) => {
              const total = Number(d.total || 0);
              const done = Number(d.done || 0);
              if (total > 0) st.textContent = `${humanSize(done)} / ${humanSize(total)} (${((done / total) * 100).toFixed(1)}%)`;
              else if (done > 0) st.textContent = humanSize(done);
            },
            onload: () => finish(true, '✓ 完成'),
            ontimeout: () => finish(false, '下载超时'),
            onerror: (err) => {
              const code = (err && err.error) || 'unknown';
              finish(false, code + (err && err.details ? ': ' + err.details : ''));
            },
          });
          // ScriptCat 返回 {abort()} 句柄；兼容返回 abort 函数本身的实现
          if (h && typeof h.abort === 'function') handle = h;
          else if (typeof h === 'function') handle = { abort: h };
        } catch (error) {
          finish(false, String(error && error.message || error));
        }
      });

      try {
        if (!(await ensureUrl(e))) {
          st.textContent = '✗ ' + e.error;
          log('取链失败: ' + name + ' — ' + e.error, true);
          return;
        }
        let result;
        if (size > 0 && size <= BLOB_NAMED_LIMIT) {
          // 小/中文件：内存转存，文件名保证正确
          result = await blobDownloadNamed(e.url, relPath, st, (fn) => (abortXhr = fn));
          if (!result.ok && !canceled) {
            log('内存转存失败，改用浏览器直下: ' + name + ' — ' + result.message);
            result = await attempt(false);
            if (!result.ok && !canceled) {
              log('下载失败，重新获取直链重试: ' + name + ' — ' + result.message);
              if (await ensureUrl(e, true)) result = await attempt(true);
            }
          }
        } else {
          result = await attempt(false);
          if (!result.ok && !canceled) {
            log('下载失败，重新获取直链重试: ' + name + ' — ' + result.message);
            if (await ensureUrl(e, true)) result = await attempt(true);
          }
        }
        if (canceled) {
          st.textContent = '已取消';
        } else if (result.ok) {
          st.textContent = result.message;
          log('下载完成: ' + name);
        } else {
          st.textContent = '✗ ' + result.message;
          log('下载失败: ' + name + ' — ' + result.message, true);
          fallback(result.message);
        }
      } catch (error) {
        st.textContent = '✗ 异常';
        log('单文件下载异常: ' + name + ' — ' + (error.message || error), true);
      } finally {
        e.downloading = false;
        cancel.remove();
      }
    };
    void run().catch((error) => log('下载任务异常: ' + (error.message || error), true));
  }

  // ---------------------------------------------------------------- 在线播放
  // 点击"播放"→ toast"正在解析"→ 取直链 → 内置播放器直接流播，不经下载。
  let toastEl = null;
  let toastTimer = 0;

  function showToast(msg, ms = 3000, isError = false) {
    if (!document.documentElement) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'pph-toast';
      document.documentElement.append(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = 'show' + (isError ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = ''; }, ms);
  }

  function closePlayer() {
    const box = document.getElementById('pph-player');
    if (!box) return;
    const v = box.querySelector('video');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    box.classList.remove('open');
  }

  function ensurePlayerBox() {
    let box = document.getElementById('pph-player');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'pph-player';
    box.innerHTML = `
      <div class="pph-pv">
        <div class="pph-pv-head"><span class="t"></span><span class="x" title="关闭">×</span></div>
        <video controls autoplay playsinline></video>
        <div class="pph-pv-tip"></div>
      </div>`;
    document.documentElement.append(box);
    box.querySelector('.x').onclick = closePlayer;
    box.onclick = (ev) => { if (ev.target === box) closePlayer(); };
    return box;
  }

  function playerHint(box, text, withTransRetry, entry) {
    const tip = box.querySelector('.pph-pv-tip');
    tip.textContent = text || '';
    tip.style.display = text ? 'block' : 'none';
    if (text && withTransRetry && entry) {
      const a = document.createElement('a');
      a.textContent = '尝试转码流重试';
      a.onclick = async () => {
        showToast('正在解析转码流…');
        try {
          const resolved = await resolveUrl(state.shareId, state.pctToken, entry.file.id, entry.file, true);
          box.querySelector('video').src = resolved.url;
          playerHint(box, '', false);
          const t = box.querySelector('.pph-pv-head .t');
          if (!/（转码流）$/.test(t.textContent)) t.textContent += '（转码流）';
          showToast('已切换转码流', 1500);
        } catch (err) {
          showToast('转码流解析失败: ' + (err.message || err), 3000, true);
        }
      };
      tip.append(' ', a);
    }
  }

  function openPlayer(entry, name, url) {
    const box = ensurePlayerBox();
    box.querySelector('.pph-pv-head .t').textContent = name;
    const v = box.querySelector('video');
    v.onloadedmetadata = () => playerHint(box, '', false);
    v.onerror = () => playerHint(box,
      '浏览器无法解码该视频（常见于 HEVC / AV1 / E-AC3 原画编码）。可尝试转码流（兼容性更好、清晰度可能较低），或下载后用 VLC / PotPlayer 播放。',
      true, entry);
    v.src = url;
    v.play().catch(() => { /* 自动播放被浏览器策略拦截时，用户手动点播放即可 */ });
    box.classList.add('open');
  }

  async function playMedia(entry) {
    if (state.busy || entry.downloading) return;
    const name = entry.path.split('/').pop();
    showToast(`正在解析: ${name}…`);
    const ok = await ensureUrl(entry);
    if (!ok || !entry.url) {
      showToast('解析失败: ' + (entry.error || '无可用直链'), 3000, true);
      return;
    }
    openPlayer(entry, name, entry.url);
    showToast('解析完成，开始播放', 1500);
  }

  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closePlayer(); });

  function saveTextFile(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  }

  // 为一组 entry 补齐直链：3 路并发（ensureUrl 内部自带节流与 429 退避），带进度与中止
  async function fillUrls(entries) {
    const total = entries.length;
    let done = 0;
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (state.aborted) return;
        const i = next++;
        if (i >= total) return;
        await ensureUrl(entries[i]);
        done++;
        statEl.textContent = `取直链: ${done}/${total}`;
        setProgress(done / total);
        if (done % 20 === 0) renderList(visibleEntries());
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, Math.max(1, total)) }, worker));
    setProgress(null);
    renderList(visibleEntries());
    return entries.filter((e) => e.url).length;
  }

  function showPassField(show) {
    const input = panel && panel.querySelector('#pph-pass');
    if (!input) return;
    const wrap = input.closest('#pph-field');
    if (wrap) wrap.style.display = show ? 'flex' : 'none';
  }

  async function ensureShare() {
    const sid = currentShareId();
    if (!sid) throw new Error('当前页面不是分享链接');
    if (state.shareId === sid && state.pctToken) return;
    state.shareId = sid;
    state.passCode = (panel?.querySelector('#pph-pass')?.value || '').trim();
    if (nav.shareId !== sid) { nav.shareId = sid; nav.parentId = ''; nav.pagePct = ''; }
    // 优先复用页面自己的 pass_code_token（与页面会话一致，含用户已输入的提取码），
    // 否则自己匿名获取
    if (nav.pagePct) {
      state.pctToken = nav.pagePct;
      if (!state.rootId) {
        try {
          // establishProfile 会锁定可用凭证，我们后续的 file_info 等请求都要用
          const info = await establishProfile(sid);
          state.rootId = (info.files?.[0] || {}).id || '';
          state.title = info.title || document.title.split(' Shared by ')[0].trim();
        } catch { /* rootId 留空, resolveScanRoot 会再取 */ }
      }
      log(`分享: ${state.title || sid}（复用页面会话，凭证 ${ACTIVE.name}）`);
      renderAuth();
      return;
    }
    let info = await establishProfile(sid);
    if (info.share_status !== 'OK') {
      if (state.passCode) {
        info = await shareInfo(sid, state.passCode);
      } else {
        showPassField(true);
        throw new Error('该分享需要提取码：请在面板"提取码"框填写后重新扫描');
      }
    }
    if (info.share_status !== 'OK') throw new Error('分享不可用: ' + (info.share_status || '未知'));
    showPassField(false);
    state.title = info.title || '';
    state.pctToken = info.pass_code_token;
    state.rootId = (info.files?.[0] || {}).id || '';
    log(`分享: ${state.title}（${AUTH ? '已登录' : '匿名模式'}，凭证 ${ACTIVE.name}）`);
    renderAuth();
  }

  // 确定扫描起点：页面正在浏览的目录 > 分享根目录
  async function resolveScanRoot() {
    let pid = '';
    if (nav.shareId === state.shareId && nav.parentId) {
      pid = nav.parentId;
    } else {
      pid = detectParentFromPerf(state.shareId);
    }
    if (pid) {
      // 校验该目录仍属于当前分享且可列出；页面 token 不被接受时换匿名 token 重试
      try {
        await listFolder(state.shareId, state.pctToken, pid);
        return { id: pid, from: '当前浏览目录' };
      } catch {
        try {
          const info = await shareInfo(state.shareId);
          state.rootId = (info.files?.[0] || {}).id || '';
          if (info.pass_code_token) state.pctToken = info.pass_code_token;
          await listFolder(state.shareId, state.pctToken, pid);
          return { id: pid, from: '当前浏览目录' };
        } catch { /* fallthrough 到根目录 */ }
      }
    }
    if (!state.rootId) {
      const info = await shareInfo(state.shareId);
      state.rootId = (info.files?.[0] || {}).id || '';
      if (info.pass_code_token && !state.pctToken) state.pctToken = info.pass_code_token;
    }
    return { id: state.rootId, from: '分享根目录（未捕获到你所在的子目录）' };
  }

  async function doScan(recursive) {
    try {
      await ensureShare();
    } catch (e) {
      return log('初始化失败: ' + e.message, true);
    }
    state.aborted = false;
    setBusy(true);
    setProgress(null);
    try {
      const root = await resolveScanRoot();
      if (recursive) {
        // 断点续扫：同分享同起点的未完成扫描，询问是否继续
        let seed = null;
        const cp = GM_getValue(SCAN_CP_KEY);
        if (cp && cp.shareId === state.shareId && cp.rootId === root.id && Array.isArray(cp.queue) && cp.queue.length) {
          const ok = confirm(`发现上次未完成的扫描（已扫 ${cp.dirsDone} 个目录，剩 ${cp.queue.length} 个待扫，已得 ${cp.results.length} 个文件）。\n从断点继续吗？（"取消"将重新开始）`);
          if (ok) seed = { queue: cp.queue, results: cp.results, errors: cp.errors || [], dirsDone: cp.dirsDone || 0 };
        }
        log(`递归扫描（起点: ${root.from}${seed ? '，从断点续扫' : ''}）…`);
        const res = await scanTree(state.shareId, state.pctToken, root.id, (dirs, pending, files) => {
          statEl.textContent = `已扫 ${dirs} 个目录（待处理 ${pending}），文件 ${files} 个`;
        }, state, seed);
        state.entries = res.results;
        state.scanErrors = res.errors;
        if (res.errors.length) {
          const preview = res.errors.slice(0, 3).map((x) => `${x.path}: ${x.message}`).join('；');
          log(`跳过 ${res.errors.length} 个列出失败的目录: ${preview}${res.errors.length > 3 ? '…' : ''}`, true);
        }
        if (state.aborted) log('扫描已中止，进度已保存，下次"扫描全部(递归)"可从断点继续');
      } else {
        const items = await listFolder(state.shareId, state.pctToken, root.id);
        state.dirStack = [{ id: root.id, path: '' }];
        state.entries = items.map((f) => f.kind === 'drive#folder'
          ? { path: '/' + sanitize(f.name), file: null, folderId: f.id }
          : { path: '/' + sanitize(f.name), file: f, selected: true });
        state.scanErrors = [];
        const nFolder = state.entries.filter((e) => !e.file).length;
        const nFile = state.entries.length - nFolder;
        log(`当前目录(${root.from}): ${nFile} 个文件, ${nFolder} 个文件夹`);
        if (nFile === 0 && nFolder > 0) {
          log('提示: 当前目录只有子文件夹。点击列表中的文件夹条目"进入"，或使用"扫描全部(递归)"。');
        }
      }
      const total = state.entries.reduce((s, e) => s + Number(e.file?.size || 0), 0);
      statEl.textContent = `扫描完成: ${state.entries.filter((e) => e.file).length} 个文件 / ${humanSize(total)}（直链在推送或点击时按需获取）`;
      renderList(visibleEntries());
      updateActionButtons();
      persistLastScan();
    } catch (e) {
      log('扫描失败: ' + e.message, true);
    } finally {
      setBusy(false);
    }
  }

  // 批量推送：可传入指定目标（"重试失败项"用），默认取当前可见且勾选的文件。
  // 2 路并发（取链+入队），对 aria2 已有同名任务的目标自动跳过。
  async function doBatchAria2(target) {
    if (!state.entries.length) return log('请先扫描');
    if (!target) target = selectedTargets();
    if (!target.length) return log('没有可下载的文件（检查过滤/搜索/勾选状态）');
    setBusy(true);
    state.aborted = false;
    setProgress(null);
    const snapshot = {
      rpcUrl: cfg.rpcUrl,
      secret: cfg.secret,
      savePath: cfg.savePath,
      proxy: cfg.proxy.trim(),
    };
    if (!String(snapshot.savePath || '').trim()) {
      setBusy(false);
      return log('请先填写保存目录（面板输入框或 ScriptCat 脚本设置）', true);
    }
    try {
      log(`开始处理 ${target.length} 个文件（取直链 + 推送 aria2）…`);
      const known = await getAria2KnownPaths(snapshot.rpcUrl, snapshot.secret);
      const pushedInBatch = new Set();
      let queued = 0, fail = 0, done = 0, skipped = 0;
      const failedEntries = [];
      let next = 0;
      const worker = async () => {
        for (;;) {
          if (state.aborted) return;
          const i = next++;
          if (i >= target.length) return;
          const entry = target[i];
          const out = entry.path.slice(entry.path.lastIndexOf('/') + 1);
          const gotUrl = await ensureUrl(entry);
          done++;
          if (!gotUrl || !entry.url) {
            fail++;
            failedEntries.push(entry);
            log('取链失败: ' + out + ' — ' + (entry.error || '无可用直链'), true);
          } else {
            let destPath = '';
            try {
              const built = aria2Options(entry, snapshot);
              destPath = (built.options.dir + '/' + built.options.out).replace(/\\/g, '/');
              if (known.has(destPath) || pushedInBatch.has(destPath)) {
                skipped++;
                log('跳过（aria2 已有该文件的任务，避免重复推送）: ' + out);
              } else {
                const gid = await aria2Call(snapshot.rpcUrl, snapshot.secret, 'aria2.addUri',
                  [[entry.url], built.options]);
                if (typeof gid !== 'string' || !gid) throw new Error('aria2 未返回任务 GID');
                pushedInBatch.add(destPath);
                const ui = ensureAriaTaskRow(entry, gid);
                aria2Tasks.set(gid, {
                  gid,
                  rpcUrl: snapshot.rpcUrl,
                  secret: snapshot.secret,
                  expectedSize: Number(entry.file.size || 0),
                  status: ui ? ui.status : { textContent: '' },
                  terminal: false,
                  entry,               // 供失败后自动重推
                  snapshot,            // 推送时的 RPC/目录/代理快照
                  multiConn: built.options.split !== '1',
                  retried: false,
                });
                queued++;
                startAria2Monitor();
              }
            } catch (error) {
              fail++;
              failedEntries.push(entry);
              log('aria2 入队失败: ' + out + ' — ' + (error.message || error), true);
            }
            await sleep(120);
          }
          statEl.textContent = `处理进度: ${done}/${target.length}（已入队 ${queued} / 失败 ${fail}${skipped ? ` / 跳过 ${skipped}` : ''}）`;
          setProgress(done / target.length);
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, target.length) }, worker));
      setProgress(null);
      const suffix = state.aborted ? '（已中止）' : '';
      log(`处理完成：已入队 ${queued} / 失败 ${fail} / 跳过 ${skipped}${suffix}。实际速度请看 aria2 任务区。`);
      if (failedEntries.length) state.lastFailed = failedEntries;
      else state.lastFailed = [];
      if (queued) GM_notification({ text: `已入队 ${queued} 个 aria2 任务（不是已完成）`, title: 'PikPak 助手' });
    } catch (error) {
      log('批量下载失败: ' + (error.message || error), true);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // 只重试上次批量推送中失败的文件
  function retryFailed() {
    const failed = (state.lastFailed || []).filter((e) => e.file);
    if (!failed.length) return log('没有待重试的失败项');
    log(`重试 ${failed.length} 个失败项…`);
    void doBatchAria2(failed);
  }

  async function doTestAria2() {
    log('测试 aria2 连接 ' + cfg.rpcUrl + ' …');
    try {
      const v = await aria2Call(cfg.rpcUrl, cfg.secret, 'aria2.getVersion', []);
      log('✓ aria2 连接成功, 版本 ' + v.version + '（配置正确，可直接推送）');
    } catch (e) {
      log('✗ ' + e.message);
    }
  }

  async function doExportAria2() {
    if (!state.entries.length) return log('请先扫描');
    setBusy(true);
    state.aborted = false;
    try {
      const target = selectedTargets();
      if (!target.length) return log('没有可导出的文件（检查过滤/搜索/勾选状态）');
      const n = await fillUrls(target);
      if (state.aborted && !n) return;
      const lines = [];
      const snapshot = { savePath: cfg.savePath, proxy: cfg.proxy.trim() };
      for (const e of target) {
        if (!e.url) continue;
        const built = aria2Options(e, snapshot);
        lines.push(e.url);
        lines.push('  dir=' + built.options.dir);
        lines.push('  out=' + built.options.out);
        lines.push('  split=' + built.options.split);
        lines.push('  max-connection-per-server=' + built.options['max-connection-per-server']);
        lines.push('  min-split-size=' + built.options['min-split-size']);
        lines.push('  continue=' + built.options.continue);
        lines.push('  max-tries=' + built.options['max-tries']);
        lines.push('  retry-wait=' + built.options['retry-wait']);
        if (snapshot.proxy) lines.push('  all-proxy=' + snapshot.proxy);
        for (const header of built.options.header) lines.push('  header=' + header);
      }
      saveTextFile(lines.join('\n') + '\n', `pikpak_${sanitize(state.title) || state.shareId}.aria2.txt`);
      log(`已导出 aria2 列表（${lines.filter((l) => l && !l.startsWith('  ')).length} 条 URL），用法: aria2c -i 文件 --continue=true`);
    } finally {
      setBusy(false);
    }
  }

  async function doExportUrls() {
    if (!state.entries.length) return log('请先扫描');
    setBusy(true);
    state.aborted = false;
    try {
      const target = selectedTargets();
      if (!target.length) return log('没有可导出的文件（检查过滤/搜索/勾选状态）');
      const n = await fillUrls(target);
      if (state.aborted && !n) return;
      // 带相对路径注释，方便离线核对；直链本身仍按行给出
      const lines = target.filter((e) => e.url).map((e) => `# ${e.path}\n${e.url}`);
      saveTextFile(lines.join('\n') + '\n', `pikpak_${state.shareId}.urls.txt`);
      log(`已导出 ${n} 条直链`);
    } finally {
      setBusy(false);
    }
  }

  function buildPanel() {
    const btn = document.createElement('button');
    btn.id = 'pph-btn';
    btn.textContent = 'PikPak 下载助手';
    document.documentElement.append(btn);

    panel = document.createElement('div');
    panel.id = 'pph-panel';
    panel.innerHTML = `
      <div id="pph-head">
        <span class="ttl">PikPak 分享下载助手</span>
        <span class="ver">v${GM_info.script.version}</span>
        <span class="x" id="pph-close">×</span>
      </div>
      <div id="pph-auth">
        <span class="dot off" id="pph-dot"></span>
        <span class="txt" id="pph-authtxt">检测登录中…</span>
        <button class="sec" id="pph-detect">重新检测</button>
      </div>
      <div id="pph-notice" role="note" aria-live="polite">
        <strong>下载规则提示</strong>
        <ul>
          <li class="ok">媒体文件（视频 / 音频 / 图片）：脚本不设大小限制（实际仍受 PikPak/CDN 策略影响）。</li>
          <li class="warn">非媒体文件（压缩包 / 文档 / 程序）：需要登录，且当前仅支持小于 100 MB。</li>
          <li>普通非会员每日下载提示为 20 GB；媒体文件不计入此项（实际以账号和平台策略为准）。</li>
          <li>大文件或批量任务建议推送 aria2；aria2 必须配置与浏览器相同的代理。</li>
        </ul>
      </div>
      <div class="pph-sec">
        <div class="hd">扫描</div>
        <button id="pph-scan">扫描当前目录</button>
        <button id="pph-scanall">扫描全部(递归)</button>
        <button id="pph-up" class="sec" disabled>⬆上级</button>
        <button id="pph-restore" class="sec">恢复上次扫描</button>
        <button id="pph-abort" class="sec" disabled>中止</button>
        <div id="pph-field"><label>文件过滤</label><input id="pph-ext" placeholder="扩展名，如 mkv,mp4（留空=全部）"></div>
        <div id="pph-field"><label>搜索</label><input id="pph-search" placeholder="按路径关键字筛选列表（实时生效）"></div>
        <div id="pph-field"><label>排序</label><select id="pph-sort">
          <option value="">默认顺序</option>
          <option value="name">按名称</option>
          <option value="size">按大小（大→小）</option>
        </select></div>
        <div id="pph-field" style="display:none"><label>提取码</label><input id="pph-pass" placeholder="该分享需要提取码时填写，然后重新扫描"></div>
        <button id="pph-selall" class="sec">全选</button>
        <button id="pph-selinv" class="sec">反选</button>
        <label class="pph-chk"><input type="checkbox" id="pph-trans">优先转码（原画放不了 AV1/HEVC 时勾选，取兼容性更好的转码流）</label>
      </div>
      <div class="pph-sec">
        <div class="hd">下载 / 导出</div>
        <button id="pph-dl" class="pph-red">推送 aria2</button>
        <button id="pph-retry" class="sec">重试失败项</button>
        <button id="pph-test" class="sec">测试连接</button>
        <button id="pph-exp2" class="sec">导出列表</button>
        <button id="pph-txt" class="sec">导出URL</button>
        <div id="pph-field"><label>aria2 RPC</label><input id="pph-rpc" placeholder="http://127.0.0.1:6800/jsonrpc"></div>
        <div id="pph-field"><label>RPC 密钥</label><input id="pph-sec-in" type="text" placeholder="--rpc-secret 的值，可空"></div>
        <div id="pph-field"><label>aria2 代理</label><input id="pph-proxy" placeholder="如 http://127.0.0.1:7890（浏览器需代理时填写）"></div>
        <div id="pph-field"><label>保存目录</label><input id="pph-path" placeholder="如 D:/Downloads"></div>
      </div>
      <div id="pph-stat"></div>
      <div id="pph-progress"><div class="bar"></div></div>
      <div id="pph-list"></div>
      <div id="pph-dltasks"></div>
      <div id="pph-aria2tasks"></div>
      <div id="pph-logbar"><span>日志</span><a id="pph-clearlog">清空</a></div>
      <div id="pph-log"></div>
      <div id="pph-foot">媒体文件不设脚本大小拦截；非媒体文件需登录且仅接受小于 100 MB。文件夹条目可点击"进入"，列表支持搜索/排序/勾选。直链约 38h 过期 · aria2 任务区会显示实际速度、错误与大小校验。</div>
    `;
    document.documentElement.append(panel);

    btn.onclick = () => {
      const show = panel.style.display !== 'block';
      panel.style.display = show ? 'block' : 'none';
      GM_setValue('panelOpen', show);
      if (show) renderAuth();
    };
    panel.querySelector('#pph-close').onclick = () => { panel.style.display = 'none'; GM_setValue('panelOpen', false); };
    logEl = panel.querySelector('#pph-log');
    listEl = panel.querySelector('#pph-list');
    statEl = panel.querySelector('#pph-stat');
    abortBtn = panel.querySelector('#pph-abort');
    dlTasksEl = panel.querySelector('#pph-dltasks');
    aria2TasksEl = panel.querySelector('#pph-aria2tasks');
    authEl = { dot: panel.querySelector('#pph-dot'), txt: panel.querySelector('#pph-authtxt') };
    panel.querySelector('#pph-clearlog').onclick = () => { logEl.innerHTML = ''; };
    panel.querySelector('#pph-detect').onclick = () => { AUTH_REJECTED = ''; refreshAuth(); renderAuth(); log('已重新检测登录状态'); };
    panel.querySelector('#pph-scan').onclick = () => doScan(false);
    panel.querySelector('#pph-scanall').onclick = () => doScan(true);
    panel.querySelector('#pph-up').onclick = scanUp;
    panel.querySelector('#pph-restore').onclick = restoreLastScan;
    panel.querySelector('#pph-dl').onclick = () => void doBatchAria2();
    panel.querySelector('#pph-retry').onclick = retryFailed;
    panel.querySelector('#pph-test').onclick = doTestAria2;
    panel.querySelector('#pph-exp2').onclick = doExportAria2;
    panel.querySelector('#pph-txt').onclick = doExportUrls;
    abortBtn.onclick = () => { state.aborted = true; log('已请求中止…'); };
    panel.querySelector('#pph-ext').oninput = () => { renderList(visibleEntries()); updateActionButtons(); };
    panel.querySelector('#pph-search').oninput = () => { renderList(visibleEntries()); updateActionButtons(); };
    panel.querySelector('#pph-sort').onchange = () => renderList(visibleEntries());
    panel.querySelector('#pph-selall').onclick = () => {
      for (const e of visibleEntries()) if (e.file) e.selected = true;
      renderList(visibleEntries()); updateActionButtons();
    };
    panel.querySelector('#pph-selinv').onclick = () => {
      for (const e of visibleEntries()) if (e.file) e.selected = e.selected === false;
      renderList(visibleEntries()); updateActionButtons();
    };
    panel.querySelector('#pph-rpc').value = cfg.rpcUrl;
    panel.querySelector('#pph-rpc').onchange = (e) => (cfg.rpcUrl = e.target.value.trim());
    panel.querySelector('#pph-sec-in').value = cfg.secret;
    panel.querySelector('#pph-sec-in').onchange = (e) => (cfg.secret = e.target.value.trim());
    panel.querySelector('#pph-proxy').value = cfg.proxy;
    panel.querySelector('#pph-proxy').onchange = (e) => (cfg.proxy = e.target.value.trim());
    panel.querySelector('#pph-path').value = cfg.savePath;
    panel.querySelector('#pph-path').onchange = (e) => (cfg.savePath = e.target.value.trim());
    const trans = panel.querySelector('#pph-trans');
    trans.checked = cfg.preferTranscoding;
    trans.onchange = (e) => {
      cfg.preferTranscoding = e.target.checked;
      // 切换后清掉已缓存的直链，下次取链按新偏好重取
      for (const en of state.entries) { if (en.file) { en.url = null; en.error = null; } }
      log('优先转码: ' + (e.target.checked ? '开（取转码流）' : '关（取原画）') + '，已清空直链缓存');
    };
    // 记住面板展开状态
    if (GM_getValue('panelOpen', false)) panel.style.display = 'block';
    updateActionButtons();
    renderAuth();
    // 配置摘要：推送失败时先看这里——代理/密钥/保存目录是否如预期
    log(`配置: RPC=${cfg.rpcUrl} · 密钥=${cfg.secret ? '已设置' : '未设置'} · 代理=${cfg.proxy.trim() || '未设置（浏览器需代理时 aria2 也必须配置同一代理）'} · 保存目录=${cfg.savePath}`);
  }

  // 刷新登录状态条：绿点=已登录（非媒体文件可下），黄点=匿名（仅媒体）
  function renderAuth() {
    if (!authEl) return;
    const a = refreshAuth();
    if (a) {
      const mins = a.expiresAt ? Math.round((a.expiresAt - Date.now()) / 60000) : 0;
      const exp = mins > 0 ? `，剩约 ${mins} 分钟` : (a.expiresAt ? '，可能已过期' : '');
      authEl.dot.className = 'dot on';
      authEl.txt.textContent = `已登录（${a.userId || '当前会话'}）· 压缩包等可下${exp} · 凭证 ${ACTIVE.name}`;
    } else {
      authEl.dot.className = 'dot off';
      authEl.txt.textContent = `匿名模式 · 仅视频/音频/图片；压缩包请先在本页登录 PikPak · 凭证 ${ACTIVE.name}`;
    }
  }

  // ---------------------------------------------------------------- 引导
  function isSharePage() {
    return /\/s\/[^/]+/.test(location.pathname);
  }

  hookPageRequests();
  // 面板只在分享页构建；首页/其他页面静默等待 SPA 导航到分享页
  if (isSharePage()) buildPanel();

  // SPA 导航：站点在站内跳转不会重载页面，需要自己跟随 URL 变化
  if (typeof window.onurlchange !== 'undefined') {
    window.addEventListener('urlchange', (e) => {
      try {
        const url = new URL(e.url, location.href);
        if (url.hostname !== location.hostname) return;
        const m = url.pathname.match(/\/s\/([^/]+)/);
        const newSid = m ? m[1] : '';
        if (newSid) {
          if (!panel) { buildPanel(); return; }
          // 切换到另一个分享：清空旧状态，避免旧 token / 旧列表 / 旧勾选串台
          if (state.shareId && newSid !== state.shareId) {
            state.shareId = '';
            state.pctToken = null;
            state.rootId = '';
            state.title = '';
            state.entries = [];
            state.scanErrors = [];
            state.dirStack = [];
            state.lastFailed = [];
            listEl.innerHTML = '';
            statEl.textContent = '分享已切换，请重新扫描';
            log('检测到切换分享，已清空旧扫描结果');
            renderAuth();
          }
        } else if (panel) {
          panel.style.display = 'none';
        }
      } catch { /* ignore */ }
    });
  }

  // 供控制台调试与回归测试使用的纯函数钩子（不影响页面行为）
  if (typeof window !== 'undefined') {
    window.__pph_test__ = { md5, captchaSign, sanitize, extAllowed, humanSize, urlExpireAt, isMediaFile, fileExtension };
  }
})();
