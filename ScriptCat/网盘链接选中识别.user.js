// ==UserScript==
// @name         网盘链接选中识别
// @namespace    https://github.com/Qiscard/Favorite-script
// @version      1.1.0
// @description  鼠标拖选网页文字时，自动识别其中的网盘分享链接与提取码，弹出小卡片显示链接是否有效，可一键打开、复制或关闭
// @author       Qiscard
// @license      MIT
// @homepageURL  https://github.com/Qiscard/Favorite-script
// @supportURL   https://github.com/Qiscard/Favorite-script/issues
// @updateURL    https://raw.githubusercontent.com/Qiscard/Favorite-script/main/ScriptCat/网盘链接选中识别.user.js
// @downloadURL  https://raw.githubusercontent.com/Qiscard/Favorite-script/main/ScriptCat/网盘链接选中识别.user.js
// @icon         data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🔗</text></svg>
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        CAT_userConfig
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* ==UserConfig==
general:
  enabled:
    title: 拖选自动检测
    type: switch
    default: true
  autoCheck:
    title: 自动检测链接有效性
    description: 关闭后仍会识别链接，只是不再请求网盘接口
    type: switch
    default: true
  detectMagnet:
    title: 识别磁力链接
    type: switch
    default: true
  maxItems:
    title: 单次最多显示
    type: number
    default: 5
    min: 1
    max: 10
display:
  autoClose:
    title: 自动关闭（秒）
    description: 0 表示不自动关闭
    type: number
    default: 0
    min: 0
    max: 60
    unit: s
 ==/UserConfig== */

(function () {
  "use strict";

  if (window.__netdiskSelectDetect) return;
  window.__netdiskSelectDetect = true;

  // ---------- 配置 ----------

  const cfg = {
    get enabled() {
      return GM_getValue("general.enabled", true);
    },
    get autoCheck() {
      return GM_getValue("general.autoCheck", true);
    },
    get detectMagnet() {
      return GM_getValue("general.detectMagnet", true);
    },
    get maxItems() {
      const n = Number(GM_getValue("general.maxItems", 5));
      return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 5;
    },
    get autoClose() {
      const n = Number(GM_getValue("display.autoClose", 0));
      return Number.isFinite(n) && n > 0 ? n : 0;
    },
  };

  // ---------- 网盘规则 ----------

  /**
   * 每条规则：
   *   key      内部标识
   *   name     显示名
   *   color    圆点颜色
   *   re       全局正则，第 1 个捕获组是分享码
   *   link     由分享码生成规范链接
   *   pwdParam 支持通过 URL 参数带提取码时使用的参数名
   *   check    有效性检测函数 (code, pwd, url) => Promise<{status, note}>
   */
  const RULES = [
    {
      key: "baidu",
      name: "百度网盘",
      color: "#2b7fff",
      re: /(?:https?:\/\/)?(?:pan|yun)\.baidu\.com\/s\/([0-9A-Za-z_-]{5,40})/g,
      link: (code) => `https://pan.baidu.com/s/${code}`,
      pwdParam: "pwd",
      check: checkBaidu,
    },
    {
      key: "baidu",
      name: "百度网盘",
      color: "#2b7fff",
      re: /(?:https?:\/\/)?pan\.baidu\.com\/(?:share|wap)\/init\?surl=([0-9A-Za-z_-]{5,40})/g,
      // /share/init?surl= 的分享码少一个前缀 1，补回来才是 /s/ 链接
      link: (code) => `https://pan.baidu.com/s/${/^1/.test(code) ? code : "1" + code}`,
      pwdParam: "pwd",
      check: (code, pwd) => checkBaidu(/^1/.test(code) ? code : "1" + code, pwd),
    },
    {
      key: "quark",
      name: "夸克网盘",
      color: "#5b5bf5",
      re: /(?:https?:\/\/)?pan\.quark\.cn\/s\/([0-9A-Za-z_-]{8,40})/g,
      link: (code) => `https://pan.quark.cn/s/${code}`,
      pwdParam: "pwd",
      check: checkQuark,
    },
    {
      key: "uc",
      name: "UC 网盘",
      color: "#ff6b00",
      re: /(?:https?:\/\/)?(?:drive|fast)\.uc\.cn\/s\/([0-9A-Za-z]{8,40})/g,
      link: (code) => `https://drive.uc.cn/s/${code}`,
      check: checkUc,
    },
    {
      key: "alipan",
      name: "阿里云盘",
      color: "#7b61ff",
      re: /(?:https?:\/\/)?(?:www\.)?(?:alipan|aliyundrive)\.com\/s\/([0-9A-Za-z_-]{8,40})/g,
      link: (code) => `https://www.alipan.com/s/${code}`,
      check: checkAlipan,
    },
    {
      key: "189",
      name: "天翼云盘",
      color: "#1e6fff",
      re: /(?:https?:\/\/)?(?:h5\.cloud|cloud)\.189\.cn\/(?:t\/|web\/share\?code=|share\.html#\/t\/)([0-9A-Za-z_-]{8,32})/g,
      link: (code) => `https://cloud.189.cn/t/${code}`,
      check: check189,
    },
    {
      key: "123pan",
      name: "123 云盘",
      color: "#2f7cf6",
      re: /(?:https?:\/\/)?(?:www\.)?(?:123pan|123865|123684|123652|123912)\.(?:com|cn)\/s\/([0-9A-Za-z_-]{6,32})/g,
      // 带不带 .html 后缀都能打开，统一成短形式
      link: (code) => `https://www.123pan.com/s/${code}`,
      pwdParam: "pwd",
      check: check123pan,
    },
    {
      key: "xunlei",
      name: "迅雷云盘",
      color: "#2f6bff",
      re: /(?:https?:\/\/)?pan\.xunlei\.com\/s\/([0-9A-Za-z_-]{8,40})/g,
      link: (code) => `https://pan.xunlei.com/s/${code}`,
      pwdParam: "pwd",
      check: checkXunlei,
    },
    {
      key: "115",
      name: "115 网盘",
      color: "#1f9cf0",
      re: /(?:https?:\/\/)?(?:115|115cdn|anxia)\.com\/s\/([0-9A-Za-z_-]{6,32})/g,
      link: (code) => `https://115.com/s/${code}`,
      pwdParam: "password",
      check: check115,
    },
    {
      key: "weiyun",
      name: "腾讯微云",
      color: "#12b7f5",
      re: /(?:https?:\/\/)?share\.weiyun\.com\/([0-9A-Za-z_-]{7,40})/g,
      link: (code) => `https://share.weiyun.com/${code}`,
      check: checkWeiyun,
    },
    {
      key: "lanzou",
      name: "蓝奏云",
      color: "#00a1ff",
      // 目录分享是 /b 开头，单文件是 /i 开头，优享版是 /s/，路径必须原样保留
      re: /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:lanzou[a-z]?|ilanzou)\.com\/(?:s\/)?([bi][0-9A-Za-z_-]{4,40})/g,
      rawUrl: true,
      check: checkLanzou,
    },
    {
      key: "lanzou",
      name: "蓝奏云优享版",
      color: "#00a1ff",
      re: /(?:https?:\/\/)?(?:www\.)?ilanzou\.com\/s\/([0-9A-Za-z_-]{5,40})/g,
      rawUrl: true,
      check: checkLanzou,
    },
    {
      key: "ctfile",
      name: "城通网盘",
      color: "#3b82f6",
      re: /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:ctfile\.com|545c\.com|089u\.com|474b\.com|u062\.com|t00y\.com|tc5\.us|2k\.us)\/(f|d|dir|file)\/([0-9A-Za-z_-]{6,32})/g,
      link: (code, url) => url.href,
      check: checkCtfile,
      // 该规则的分享码在第 2 组，路径类型在第 1 组
      codeGroup: 2,
      rawUrl: true,
    },
    {
      key: "wenshushu",
      name: "文叔叔",
      color: "#ff5a5f",
      re: /(?:https?:\/\/)?(?:www\.)?(?:wenshushu\.cn|wss\.ink|ws28\.cn|wss1\.cn|ws59\.cn|wss\.cc)\/(?:f|k)\/([0-9A-Za-z_-]{6,32})/g,
      link: (code) => `https://www.wenshushu.cn/f/${code}`,
      check: checkWenshushu,
    },
    {
      key: "jianguoyun",
      name: "坚果云",
      color: "#38bdf8",
      re: /(?:https?:\/\/)?(?:www\.)?jianguoyun\.com\/p\/([0-9A-Za-z_-]{10,40})/g,
      link: (code) => `https://www.jianguoyun.com/p/${code}`,
      check: checkJianguoyun,
    },
    {
      key: "feijipan",
      name: "小飞机网盘",
      color: "#22c55e",
      re: /(?:https?:\/\/)?(?:share\.)?feijipan\.com\/s\/([0-9A-Za-z_-]{5,32})/g,
      link: (code) => `https://share.feijipan.com/s/${code}`,
      check: checkGeneric,
    },
    {
      key: "360",
      name: "360 云盘",
      color: "#16a34a",
      re: /(?:https?:\/\/)?(?:[a-z0-9]+\.)?(?:link\.yunpan\.com|link\.yunpan\.360\.cn|yunpan\.360\.cn|www\.yunpan\.com)\/lk\/surl_([0-9A-Za-z]{8,40})/g,
      link: (code) => `https://www.yunpan.com/lk/surl_${code}`,
      check: checkGeneric,
    },
    {
      key: "139",
      name: "移动云盘",
      color: "#0ea5e9",
      re: /(?:https?:\/\/)?(?:yun|caiyun)\.139\.com\/(?:shareweb\/#\/w\/i\/|link\/w\/i\/|w\/i\/|m\/i\?)([0-9A-Za-z_-]{6,32})/g,
      link: (code) => `https://yun.139.com/shareweb/#/w/i/${code}`,
      check: checkGeneric,
    },
  ];

  const MAGNET_RULE = {
    key: "magnet",
    name: "磁力链接",
    color: "#a855f7",
    re: /magnet:\?xt=urn:btih:[0-9a-fA-F]{32,40}[^\s"'<>]*/g,
    magnet: true,
  };

  // ---------- 提取码 ----------

  const PWD_PATTERNS = [
    /(?:提取码|访问码|提取密码|口令|密码)\s*[:：=]?\s*([0-9A-Za-z]{3,8})/,
    /(?:pwd|password|passcode|share_pwd)\s*=\s*([0-9A-Za-z]{3,8})/i,
  ];

  function extractPwd(text) {
    for (const re of PWD_PATTERNS) {
      const m = text.match(re);
      if (m) return m[1];
    }
    return "";
  }

  // ---------- 选中文字 → 链接 ----------

  function detect(text) {
    const found = [];
    const seen = new Set();
    const limit = Math.min(text.length, 8000);
    const source = text.slice(0, limit);

    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(source)) !== null) {
        const code = m[rule.codeGroup || 1];
        if (!code) continue;
        const matchedText = m[0];
        const tail = source.slice(m.index, m.index + matchedText.length + 48);
        const pwd = extractPwd(matchedText) || extractPwd(tail);
        const key = `${rule.key}:${code}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let url;
        try {
          const base = /^https?:\/\//i.test(matchedText) ? matchedText : `https://${matchedText.replace(/^\/+/, "")}`;
          url = new URL(base);
        } catch (e) {
          continue;
        }

        found.push({
          rule,
          code,
          pwd,
          link: rule.rawUrl ? url.href.replace(/[?&](pwd|password|passcode)=[^&]*/gi, "") : rule.link(code, url),
          status: "idle",
          note: "",
          at: m.index,
        });
      }
    }

    if (cfg.detectMagnet) {
      MAGNET_RULE.re.lastIndex = 0;
      let m;
      while ((m = MAGNET_RULE.re.exec(source)) !== null) {
        const link = m[0];
        const key = `magnet:${link.slice(0, 60)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ rule: MAGNET_RULE, code: "", pwd: "", link, status: "skip", note: "无需校验", at: m.index });
      }
    }

    // 按链接在选中文字里出现的先后顺序展示，而不是按规则表顺序
    found.sort((a, b) => a.at - b.at);
    return found.slice(0, cfg.maxItems);
  }

  // ---------- 请求与缓存 ----------

  const cache = new Map(); // key -> { at, status, note }
  const inflight = new Map();
  const CACHE_TTL = 10 * 60 * 1000;

  function request(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || "GET",
        url,
        headers: options.headers || {},
        data: options.data,
        timeout: options.timeout || 12000,
        onload: resolve,
        onerror: (err) => {
          // 有些站点用 4xx 空 body 表示“不存在”，部分实现会把它当成网络错误；
          // 拿得到状态码就交回调用方按状态码判断。
          if (err && err.status) {
            resolve({ status: err.status, responseText: err.responseText || "", finalUrl: err.finalUrl || url });
            return;
          }
          reject(new Error("网络错误"));
        },
        ontimeout: () => reject(new Error("请求超时")),
      });
    });
  }

  function toJson(res) {
    try {
      return JSON.parse(res.responseText);
    } catch (e) {
      return null;
    }
  }

  // ---------- 各家网盘的有效性检测 ----------

  /**
   * 百度网盘的判定依据是分享页本身，不是 shorturlinfo。
   *
   * shorturlinfo 不可用：对同一个有效分享，它会随请求上下文在 -9（需提取码）
   * 与 -3（文件已经被删除）之间变化，把有效链接判成失效。
   *
   * 分享页是稳定的三分支：
   *   HTTP 404                            → 分享不存在
   *   SHAREPAGETYPE = 'init'              → 存在，但要提取码
   *   SHAREPAGETYPE = 'multi_file' 等     → 存在且可直接访问
   */
  async function checkBaidu(code, pwd) {
    const pageUrl = `https://pan.baidu.com/s/${code}`;
    const res = await request(pageUrl, { headers: { Referer: pageUrl } });

    if (res.status === 404 || res.status === 410) {
      return { status: "invalid", note: "分享不存在或已失效" };
    }
    if (res.status !== 200) {
      return { status: "unknown", note: `HTTP ${res.status}` };
    }

    const html = res.responseText || "";
    const pageType = (html.match(/SHAREPAGETYPE\s*=\s*'([^']*)'/) || [])[1] || "";
    const hasExpired = /你访问的页面不存在|分享的文件已经被取消|分享已过期|啊哦，你来晚了/.test(html);

    if (hasExpired) return { status: "invalid", note: "分享已失效" };
    if (pageType === "init") {
      // 存在但需要提取码，有码时用 verify 判断码对不对
      if (!pwd) return { status: "needpwd", note: "需要提取码" };
      return verifyBaiduPwd(code, pwd);
    }
    if (pageType) return { status: "valid", note: "分享正常" };

    // 没拿到 SHAREPAGETYPE（页面结构变了或触发了验证）：退回接口确认
    return checkBaiduFallback(code, pwd);
  }

  // verify 的 surl 参数是分享码去掉首位 "1"：/s/1abc → surl=abc
  async function verifyBaiduPwd(code, pwd) {
    const surl = code.replace(/^1/, "");
    const res = await request(
      `https://pan.baidu.com/share/verify?surl=${encodeURIComponent(surl)}&t=${Date.now()}000&channel=chunlei&web=1&app_id=250528&clienttype=0`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: `https://pan.baidu.com/share/init?surl=${surl}`,
        },
        data: `pwd=${encodeURIComponent(pwd)}&vcode=&vcode_str=`,
      }
    );
    const d = toJson(res) || {};
    const errno = Number(d.errno);
    if (errno === 0) return { status: "valid", note: "提取码正确" };
    if (errno === -9) return { status: "needpwd", note: "提取码错误" };
    if (errno === 105) return { status: "invalid", note: "分享不存在" };
    if (errno === -12) return { status: "valid", note: "无需提取码" };
    return { status: "unknown", note: `errno ${errno}` };
  }

  async function checkBaiduFallback(code) {
    const res = await request(`https://pan.baidu.com/s/${code}?pwd=`, {
      headers: { Referer: `https://pan.baidu.com/s/${code}` },
    });
    if (res.status === 404) return { status: "invalid", note: "分享不存在或已失效" };
    if (/输入提取码|请输入提取码/.test(res.responseText || "")) {
      return { status: "needpwd", note: "需要提取码" };
    }
    return { status: "unknown", note: "页面结构异常，请打开确认" };
  }

  async function checkQuark(code, pwd) {
    return checkCloudDriveToken(code, pwd, "https://drive-pc.quark.cn", "https://pan.quark.cn", "ucpro");
  }

  async function checkUc(code, pwd) {
    return checkCloudDriveToken(code, pwd, "https://pc-api.uc.cn", "https://drive.uc.cn", "UCBrowser");
  }

  // 夸克 / UC 共用同一套接口形态
  async function checkCloudDriveToken(code, pwd, apiHost, siteOrigin, pr) {
    const res = await request(
      `${apiHost}/1/clouddrive/share/sharepage/token?pr=${pr}&fr=pc&uc_param_str=`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: siteOrigin,
          Referer: `${siteOrigin}/s/${code}`,
        },
        data: JSON.stringify({ pwd_id: code, passcode: pwd || "" }),
      }
    );
    const d = toJson(res);
    if (!d) return { status: "unknown", note: "接口无响应" };

    const msg = String(d.message || "");
    if (Number(d.code) === 0) return { status: "valid", note: "分享正常" };
    if (msg.includes("需要提取码") || msg.includes("提取码错误")) {
      return { status: "needpwd", note: msg };
    }
    if (msg.includes("不存在") || msg.includes("失效") || Number(d.code) === 41006) {
      return { status: "invalid", note: msg || "分享不存在" };
    }
    return { status: "unknown", note: msg || `code ${d.code}` };
  }

  async function checkAlipan(code, pwd) {
    const res = await request(
      `https://api.alipan.com/adrive/v3/share_link/get_share_by_anonymous?share_id=${encodeURIComponent(code)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.alipan.com",
          Referer: `https://www.alipan.com/s/${code}`,
        },
        data: JSON.stringify({ share_id: code }),
      }
    );
    const d = toJson(res);
    if (!d) return { status: "unknown", note: "接口无响应" };

    if (d.code) {
      if (/NotFound|Cancelled|ParamFlow/.test(String(d.code))) {
        return { status: "invalid", note: d.message || "分享不存在" };
      }
      return { status: "unknown", note: d.message || String(d.code) };
    }
    if (d.need_share_pwd && !pwd) return { status: "needpwd", note: "需要提取码" };
    if (typeof d.file_count === "number" || d.share_name) return { status: "valid", note: "分享正常" };
    return { status: "unknown", note: "" };
  }

  async function check189(code) {
    const res = await request("https://cloud.189.cn/api/open/share/getShareInfoByCodeV2.action", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://cloud.189.cn",
        Referer: `https://cloud.189.cn/t/${code}`,
      },
      data: `shareCode=${encodeURIComponent(code)}`,
    });
    const text = res.responseText || "";
    if (/ShareInfoNotFound|ShareNotFound|ShareExpiredError|FileNotFound|ShareAuditNotPass/.test(text)) {
      return { status: "invalid", note: "分享不存在或已失效" };
    }
    if (/needAccessCode/.test(text)) return { status: "needpwd", note: "需要提取码" };
    if (/<error>/.test(text)) return { status: "unknown", note: "接口返回异常" };
    return { status: "valid", note: "分享正常" };
  }

  async function check123pan(code, pwd) {
    const res = await request(
      `https://www.123pan.cn/gsb/s/share-list?shareKey=${encodeURIComponent(code)}&SharePwd=${encodeURIComponent(pwd || "")}&OrderId=`,
      {
        headers: {
          Accept: "application/json, text/plain, */*",
          Origin: "https://www.123pan.com",
          Referer: `https://www.123pan.com/s/${code}`,
        },
      }
    );
    const d = toJson(res);
    if (!d) return { status: "unknown", note: "接口无响应" };

    if (Number(d.code) === 0) return { status: "valid", note: "分享正常" };
    const msg = String(d.message || "");
    if (msg.includes("密码") || msg.includes("提取码")) return { status: "needpwd", note: msg };
    if (Number(d.code) === 5103) return { status: "invalid", note: msg || "分享不存在" };
    return { status: "unknown", note: msg || `code ${d.code}` };
  }

  async function checkXunlei(code, pwd) {
    const referer = `https://pan.xunlei.com/s/${code}`;
    const init = await request("https://xluser-ssl.xunlei.com/v1/shield/captcha/init", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://pan.xunlei.com", Referer: referer },
      data: JSON.stringify({
        client_id: "Xqp0kJBXWhwaTpB6",
        device_id: "925b7631473a13716b791d7f28289cad",
        action: "get:/drive/v1/share",
        meta: {
          package_name: "pan.xunlei.com",
          client_version: "1.45.0",
          captcha_sign: "1.fe2108ad808a74c9ac0243309242726c",
          timestamp: "1645241033384",
        },
      }),
    });
    const token = (toJson(init) || {}).captcha_token;
    if (!token) return { status: "unknown", note: "验证初始化失败" };

    const res = await request(
      `https://api-pan.xunlei.com/drive/v1/share?share_id=${encodeURIComponent(code)}&pass_code=${encodeURIComponent(pwd || "")}&limit=1`,
      {
        headers: {
          "x-captcha-token": token,
          "x-client-id": "Xqp0kJBXWhwaTpB6",
          "x-device-id": "925b7631473a13716b791d7f28289cad",
          Origin: "https://pan.xunlei.com",
          Referer: referer,
        },
      }
    );
    const d = toJson(res);
    if (!d) return { status: "unknown", note: "接口无响应" };

    const err = String(d.error || "");
    if (/NOT_FOUND|EXPIRED|DELETED|SENSITIVE_RESOURCE|SHARE_NOT_FOUND/i.test(err)) {
      return { status: "invalid", note: d.error_description || "分享不存在或已失效" };
    }
    if (/PASS_CODE/i.test(err)) return { status: "needpwd", note: "需要提取码" };
    if (/invalid_argument|captcha/i.test(err)) {
      // 分享码格式不对时迅雷也回 invalid_argument，视为链接无效
      return { status: "invalid", note: "分享码格式不正确或分享不存在" };
    }
    if (err) return { status: "unknown", note: d.error_description || err };
    if (d.share) return { status: "valid", note: "分享正常" };
    return { status: "unknown", note: "" };
  }

  async function check115(code, pwd) {
    const res = await request(
      `https://webapi.115.com/share/snap?share_code=${encodeURIComponent(code)}&offset=0&limit=20&receive_code=${encodeURIComponent(pwd || "")}&cid=`,
      {
        headers: {
          Accept: "application/json, text/javascript, */*;",
          Origin: "https://115.com",
          Referer: "https://115.com/",
        },
      }
    );
    const d = toJson(res);
    if (!d) return { status: "unknown", note: "接口无响应" };

    if (d.state) return { status: "valid", note: "分享正常" };
    const err = String(d.error || "");
    if (err.includes("访问码") || err.includes("密码") || err.includes("提取")) {
      return { status: "needpwd", note: err };
    }
    if (err.includes("链接") || err.includes("取消") || err.includes("不存在")) {
      return { status: "invalid", note: err };
    }
    if (Number(d.errno) === 990002) return { status: "invalid", note: "分享不存在或链接有误" };
    return { status: "unknown", note: err || `errno ${d.errno}` };
  }

  async function checkWeiyun(code) {
    const res = await request(`https://share.weiyun.com/${code}`, {
      headers: { Referer: `https://share.weiyun.com/${code}` },
    });
    const text = res.responseText || "";
    if (/"retcode"\s*:\s*114200/.test(text)) return { status: "invalid", note: "分享不存在或已删除" };
    if (/"need_pwd"\s*:\s*1/.test(text) || /"pwd"\s*:\s*"[^"]+"/.test(text)) {
      return { status: "needpwd", note: "需要提取码" };
    }
    if (/"share_key"\s*:\s*"/.test(text)) return { status: "valid", note: "分享正常" };
    if (/已删除|已过期|目录无效|违反相关法规/.test(text)) {
      return { status: "invalid", note: "分享已失效" };
    }
    return { status: "unknown", note: "" };
  }

  async function checkLanzou(code, pwd, url) {
    const res = await request(url.href, { headers: { Referer: url.href } });
    const text = res.responseText || "";
    if (/来晚啦|文件不存在|文件链接失效|已被删除|取消分享|分享已取消/.test(text)) {
      return { status: "invalid", note: "分享不存在或已失效" };
    }
    if (/输入密码|请输入密码|密码错误|访问密码/.test(text)) {
      return { status: "needpwd", note: "需要提取码" };
    }
    if (res.status >= 400) return { status: "invalid", note: `HTTP ${res.status}` };
    if (text.length > 400) return { status: "valid", note: "分享正常" };
    return { status: "unknown", note: "" };
  }

  async function checkCtfile(code, pwd, url) {
    const isDir = /\/(d|dir)\//.test(url.pathname);
    const path = isDir ? "d" : "f";
    const res = await request(
      `https://webapi.ctfile.com/get${isDir ? "dir" : "file"}.php?path=${path}&${path}=${encodeURIComponent(
        code
      )}&passcode=${encodeURIComponent(pwd || "")}&token=0&r=${Math.random()}&ref=`,
      { headers: { Referer: url.href, Accept: "application/json, text/javascript, */*; q=0.01" } }
    );
    const d = toJson(res);
    if (!d) return { status: "unknown", note: "接口无响应" };
    if (Number(d.code) === 200) return { status: "valid", note: "分享正常" };
    if (Number(d.code) === 401) return { status: "needpwd", note: "需要提取码" };
    if (Number(d.code) === 403) return { status: "invalid", note: "分享不存在或已失效" };
    return { status: "unknown", note: `code ${d.code}` };
  }

  async function checkWenshushu(code) {
    const res = await request("https://www.wenshushu.cn/ap/task/mgrtask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-token": "wss:7pmakczzw6i",
        Origin: "https://www.wenshushu.cn",
        Referer: `https://www.wenshushu.cn/f/${code}`,
      },
      data: JSON.stringify({ tid: code }),
    });
    const d = toJson(res);
    if (!d) return { status: "unknown", note: "接口无响应" };
    if (Number(d.code) === 0) return { status: "valid", note: "分享正常" };
    if (/TASKNOTFOUND|TASKNEXT|不存在/.test(String(d.message || ""))) {
      return { status: "invalid", note: "分享不存在或已失效" };
    }
    return { status: "invalid", note: d.message || "分享不存在或已失效" };
  }

  async function checkJianguoyun(code) {
    const res = await request(`https://www.jianguoyun.com/p/${code}`, {
      headers: { Referer: `https://www.jianguoyun.com/p/${code}` },
    });
    const text = res.responseText || "";
    // 失效时是 HTTP 200 的错误页：中文版「坚果云 - 400 / 啊噢！(400)」，英文版「Nutstore - 400」
    if (
      res.status === 404 ||
      res.status >= 400 ||
      /啊噢/.test(text) ||
      /<title>[^<]*(?:坚果云|Nutstore)[^<]*-\s*4\d\d/i.test(text)
    ) {
      return { status: "invalid", note: "分享不存在或已失效" };
    }
    return { status: "valid", note: "分享正常" };
  }

  // 没有公开校验接口的网盘：只能看 HTTP 状态
  async function checkGeneric(code, pwd, url) {
    const res = await request(url.href, { headers: { Referer: url.href } });
    if (res.status === 404 || res.status === 410) {
      return { status: "invalid", note: `HTTP ${res.status}` };
    }
    return { status: "unknown", note: "该网盘无法自动校验，请打开确认" };
  }

  // ---------- 检测调度 ----------

  function checkItem(item) {
    const { rule, code, pwd, link } = item;
    if (!rule.check) return Promise.resolve({ status: "skip", note: "无需校验" });

    const key = `${rule.key}:${code}:${pwd}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL) {
      return Promise.resolve({ status: cached.status, note: cached.note });
    }
    if (inflight.has(key)) return inflight.get(key);

    let url;
    try {
      url = new URL(link);
    } catch (e) {
      return Promise.resolve({ status: "unknown", note: "链接格式异常" });
    }

    const task = rule
      .check(code, pwd, url)
      .then((result) => {
        cache.set(key, { at: Date.now(), ...result });
        return result;
      })
      .catch((err) => ({ status: "error", note: err.message || "检测失败" }))
      .finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
  }

  // ---------- 弹窗界面 ----------

  const CSS = `
:host { all: initial; }
.card, .card * {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: 0;
  font: inherit;
  color: inherit;
  background: none;
  text-align: left;
  text-decoration: none;
  text-transform: none;
  letter-spacing: normal;
  word-spacing: normal;
  text-shadow: none;
  list-style: none;
  vertical-align: baseline;
  white-space: normal;
  cursor: default;
}
.card {
  --bg: #ffffff;
  --fg: #1d1d1f;
  --muted: #6b7280;
  --line: rgba(0, 0, 0, 0.08);
  --hover: rgba(0, 0, 0, 0.05);
  --primary: #0a84ff;
  --primary-fg: #ffffff;
  --valid: #16a34a;
  --invalid: #dc2626;
  --needpwd: #d97706;
  --unknown: #6b7280;
  position: relative;
  display: block;
  width: 320px;
  max-width: calc(100vw - 16px);
  padding: 10px 12px 12px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", sans-serif;
  font-size: 12px;
  line-height: 1.45;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.08);
  animation: ndsd-in 140ms cubic-bezier(0.2, 0.8, 0.3, 1) both;
  transform-origin: var(--origin, top left);
  user-select: text;
}
@media (prefers-color-scheme: dark) {
  .card {
    --bg: #1f2023;
    --fg: #f2f3f5;
    --muted: #9aa0a6;
    --line: rgba(255, 255, 255, 0.12);
    --hover: rgba(255, 255, 255, 0.08);
    --valid: #4ade80;
    --invalid: #f87171;
    --needpwd: #fbbf24;
    --unknown: #9aa0a6;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.3);
  }
}
@keyframes ndsd-in {
  from { opacity: 0; transform: scale(0.96) translateY(-3px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .card { animation: none; }
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
}
.head-title {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.close {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  color: var(--muted);
  font-size: 15px;
  line-height: 18px;
  text-align: center;
  cursor: pointer;
}
.close:hover { background: var(--hover); color: var(--fg); }
.list { display: block; }
.item {
  display: block;
  padding: 9px 0 2px;
  border-bottom: 1px solid var(--line);
}
.item:last-child { border-bottom: 0; padding-bottom: 0; }
.row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--unknown);
}
.drive {
  flex: 1;
  font-weight: 600;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 16px;
  color: var(--unknown);
  background: var(--hover);
}
.badge[data-status="valid"] { color: var(--valid); }
.badge[data-status="invalid"] { color: var(--invalid); }
.badge[data-status="needpwd"] { color: var(--needpwd); }
.badge[data-status="checking"] .badge-dot { animation: ndsd-pulse 1s ease-in-out infinite; }
@keyframes ndsd-pulse { 50% { opacity: 0.25; } }
.badge-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.link {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
  word-break: break-all;
  user-select: text;
}
.pwd {
  display: inline-block;
  margin-top: 4px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--hover);
  color: var(--fg);
  font-size: 11px;
  line-height: 17px;
  letter-spacing: 0.02em;
}
.note {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
}
.actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  padding-bottom: 6px;
}
.btn {
  flex: none;
  padding: 4px 12px;
  border-radius: 7px;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: filter 120ms ease, background-color 120ms ease;
}
.btn:hover { filter: brightness(0.96); }
.btn:active { filter: brightness(0.9); }
.btn.primary {
  background: var(--primary);
  color: var(--primary-fg);
  font-weight: 500;
}
.btn.ghost {
  background: var(--hover);
  color: var(--fg);
}
.btn[data-done="1"] { color: var(--valid); }
.foot {
  display: none;
}
`;

  const state = {
    host: null,
    shadow: null,
    items: [],
    anchor: null,
    lastKey: "",
    closeTimer: 0,
  };

  function ensureHost() {
    if (state.host && state.host.isConnected) return state.host;

    const host = document.createElement("div");
    host.id = "ndsd-root";
    host.setAttribute(
      "style",
      "position:fixed;left:0;top:0;z-index:2147483647;display:block;width:max-content;max-width:100vw;"
    );

    const shadow = host.attachShadow({ mode: "open" });
    let sheet;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (e) {
      const style = document.createElement("style");
      style.textContent = CSS;
      shadow.appendChild(style);
    }

    const card = document.createElement("div");
    card.className = "card";
    shadow.appendChild(card);

    (document.body || document.documentElement).appendChild(host);

    state.host = host;
    state.shadow = shadow;
    state.card = card;
    return host;
  }

  function statusText(status) {
    switch (status) {
      case "checking":
        return "检测中";
      case "valid":
        return "有效";
      case "invalid":
        return "已失效";
      case "needpwd":
        return "需要提取码";
      case "skip":
        return "无需校验";
      case "error":
        return "检测失败";
      default:
        return "未检测";
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function render() {
    const card = state.card;
    if (!card) return;
    card.textContent = "";

    const head = el("div", "head");
    head.appendChild(el("span", "head-title", `检测到 ${state.items.length} 个分享链接`));
    const close = el("div", "close", "×");
    close.setAttribute("title", "关闭");
    close.setAttribute("role", "button");
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      hide();
    });
    head.appendChild(close);
    card.appendChild(head);

    const list = el("div", "list");
    state.items.forEach((item, index) => {
      const row = el("div", "item");
      row.dataset.index = String(index);

      const top = el("div", "row");
      const dot = el("span", "dot");
      dot.style.background = item.rule.color;
      top.appendChild(dot);
      top.appendChild(el("span", "drive", item.rule.name));

      const badge = el("span", "badge");
      badge.dataset.status = item.status;
      badge.appendChild(el("span", "badge-dot"));
      badge.appendChild(el("span", "badge-text", statusText(item.status)));
      top.appendChild(badge);
      row.appendChild(top);

      row.appendChild(el("span", "link", item.link.replace(/^https?:\/\//, "")));

      if (item.pwd) row.appendChild(el("span", "pwd", `提取码 ${item.pwd}`));
      if (item.note) row.appendChild(el("span", "note", item.note));

      const actions = el("div", "actions");
      const openBtn = el("button", "btn primary", "打开");
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openItem(item);
      });
      const copyBtn = el("button", "btn ghost", "复制");
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        copyItem(item, copyBtn);
      });
      actions.appendChild(openBtn);
      actions.appendChild(copyBtn);
      row.appendChild(actions);

      list.appendChild(row);
    });
    card.appendChild(list);
  }

  function updateItem(index) {
    const row = state.card && state.card.querySelector(`.item[data-index="${index}"]`);
    const item = state.items[index];
    if (!row || !item) return;

    const badge = row.querySelector(".badge");
    badge.dataset.status = item.status;
    badge.querySelector(".badge-text").textContent = statusText(item.status);

    let note = row.querySelector(".note");
    if (item.note) {
      if (!note) {
        note = el("span", "note");
        const actions = row.querySelector(".actions");
        row.insertBefore(note, actions);
      }
      note.textContent = item.note;
    } else if (note) {
      note.remove();
    }
  }

  function openItem(item) {
    let url = item.link;
    if (item.pwd && item.rule.pwdParam) {
      try {
        const u = new URL(url);
        u.searchParams.set(item.rule.pwdParam, item.pwd);
        url = u.href;
      } catch (e) {
        /* 保持原链接 */
      }
    }
    GM_openInTab(url, { active: true, insert: true });
  }

  function copyItem(item, button) {
    const text = item.pwd ? `${item.link}\n提取码：${item.pwd}` : item.link;
    GM_setClipboard(text);
    const old = button.textContent;
    button.textContent = "已复制";
    button.dataset.done = "1";
    setTimeout(() => {
      button.textContent = old;
      delete button.dataset.done;
    }, 1200);
  }

  function place(anchor) {
    const host = state.host;
    if (!host) return;
    const margin = 8;
    const gap = 14;
    const width = host.offsetWidth;
    const height = host.offsetHeight;

    let left = anchor.x + gap;
    let top = anchor.y + gap;
    let originY = "top";

    if (left + width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - width - margin);
    }
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, anchor.y - height - gap);
      originY = "bottom";
    }
    const originX = left + width / 2 < anchor.x ? "left" : "right";
    state.card.style.setProperty("--origin", `${originY} ${originX}`);

    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
  }

  function show(items, anchor) {
    ensureHost();
    state.items = items;
    state.anchor = anchor;
    state.lastKey = items.map((it) => it.link).join("|");

    render();
    state.host.style.visibility = "hidden";
    state.host.style.display = "block";
    place(anchor);
    state.host.style.visibility = "visible";

    if (state.closeTimer) clearTimeout(state.closeTimer);
    if (cfg.autoClose) {
      state.closeTimer = setTimeout(hide, cfg.autoClose * 1000);
    }

    if (cfg.autoCheck) {
      items.forEach((item, index) => {
        if (item.status === "skip") return;
        item.status = "checking";
        updateItem(index);
        checkItem(item).then((result) => {
          // 弹窗已被关闭或换成了别的链接时不再更新
          if (state.items[index] !== item) return;
          item.status = result.status;
          item.note = result.note || "";
          updateItem(index);
        });
      });
    }
  }

  function hide() {
    if (state.closeTimer) {
      clearTimeout(state.closeTimer);
      state.closeTimer = 0;
    }
    state.items = [];
    state.lastKey = "";
    if (state.host) {
      state.host.remove();
      state.host = null;
      state.shadow = null;
      state.card = null;
    }
  }

  // ---------- 事件 ----------

  function readSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const text = sel.toString();
      if (text && text.trim()) return { text, fromInput: false };
    }

    // 输入框 / 文本域里的选中文字不会出现在 window.getSelection() 里
    const active = document.activeElement;
    if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (typeof start === "number" && typeof end === "number" && end > start) {
        const text = active.value.slice(start, end);
        if (text && text.trim()) return { text, fromInput: true };
      }
    }
    return null;
  }

  function onMouseUp(event) {
    if (!cfg.enabled) return;
    if (event.button !== 0) return;
    if (event.composedPath && event.composedPath().includes(state.host)) return;

    const point = { x: event.clientX, y: event.clientY };

    // 等浏览器把选区确定下来
    setTimeout(() => {
      if (!cfg.enabled) return;
      const selection = readSelection();
      if (!selection) return;

      const items = detect(selection.text);
      if (!items.length) return;

      const key = items.map((it) => it.link).join("|");
      if (key === state.lastKey && state.host && state.host.isConnected) return;

      show(items, point);
    }, 0);
  }

  function onPointerDown(event) {
    if (!state.host) return;
    if (event.composedPath && event.composedPath().includes(state.host)) return;
    hide();
  }

  function onKeyDown(event) {
    if (event.key === "Escape" && state.host) hide();
  }

  function onScroll(event) {
    if (!state.host) return;
    if (event.composedPath && event.composedPath().includes(state.host)) return;
    hide();
  }

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScroll, true);

  // ---------- 菜单 ----------

  function renderMenu() {
    const enabled = cfg.enabled;
    GM_registerMenuCommand(
      enabled ? "✅ 拖选检测：已开启" : "⛔ 拖选检测：已关闭",
      () => {
        GM_setValue("general.enabled", !enabled);
        renderMenu();
        if (enabled) hide();
      },
      { id: "ndsd-toggle", autoClose: false }
    );
    GM_registerMenuCommand("⚙️ 打开设置", () => CAT_userConfig(), { id: "ndsd-config" });
  }

  renderMenu();
})();
