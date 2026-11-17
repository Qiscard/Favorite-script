// ==UserScript==
// @name         主动显示密码
// @namespace    https://github.com/Qiscard/Favorite-script
// @version      0.2.1
// @description  按配置的快捷键，切换当前聚焦密码框的明文/密文（不依赖网站自带的「显示密码」按钮）
// @author       Qiscard
// @license      MIT
// @homepageURL  https://github.com/Qiscard/Favorite-script
// @supportURL   https://github.com/Qiscard/Favorite-script/issues
// @updateURL    https://raw.githubusercontent.com/Qiscard/Favorite-script/main/ScriptCat/主动显示密码.user.js
// @downloadURL  https://raw.githubusercontent.com/Qiscard/Favorite-script/main/ScriptCat/主动显示密码.user.js
// @match        *://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        CAT_userConfig
// ==/UserScript==

/* ==UserConfig==
hotkey:
  combo:
    title: 切换快捷键
    description: 例如 Alt+P、Ctrl+Shift+U、F8；也可以只写一个修饰键 Ctrl / Alt / Shift / Meta，此时「快速点按」触发。修饰键可写 Ctrl、Alt、Shift、Meta（Mac 上的 Command），用 + 连接，大小写不限。保存后立即生效；个别情况下需刷新页面。浏览器自己保留的快捷键（如 Ctrl+T、Ctrl+W）无法覆盖。
    type: text
    default: Alt+P
  hold:
    title: 按住才显示
    description: 开启后，按住快捷键显示明文，松开恢复密文（只写修饰键时需按住约 0.3 秒）。关闭则每按一次切换一次。
    type: checkbox
    default: false
  toast:
    title: 显示提示
    description: 切换时在密码框附近闪一下「已显示」或「已隐藏」。
    type: checkbox
    default: true
 ==/UserConfig== */

(function () {
  "use strict";

  const REV = "r3";
  const DEFAULT_COMBO = "Alt+P";
  const LONG_PRESS_MS = 300; // 只写修饰键 + 「按住才显示」时，按住多久开始显示
  const TAP_MAX_MS = 600; // 只写修饰键 + 切换模式时，点按的时长上限

  const MOD_ALIASES = {
    ctrl: "ctrl",
    ctl: "ctrl",
    control: "ctrl",
    alt: "alt",
    option: "alt",
    opt: "alt",
    shift: "shift",
    meta: "meta",
    cmd: "meta",
    command: "meta",
    win: "meta",
    windows: "meta",
    super: "meta",
    os: "meta",
  };

  const MOD_FROM_EVENT_KEY = { control: "ctrl", alt: "alt", shift: "shift", meta: "meta", os: "meta" };

  const KEY_ALIASES = {
    esc: "escape",
    escape: "escape",
    return: "enter",
    enter: "enter",
    space: " ",
    spacebar: " ",
    del: "delete",
    delete: "delete",
    ins: "insert",
    insert: "insert",
    pgup: "pageup",
    pageup: "pageup",
    pgdn: "pagedown",
    pagedown: "pagedown",
    up: "arrowup",
    arrowup: "arrowup",
    down: "arrowdown",
    arrowdown: "arrowdown",
    left: "arrowleft",
    arrowleft: "arrowleft",
    right: "arrowright",
    arrowright: "arrowright",
    backspace: "backspace",
    plus: "+",
    minus: "-",
  };

  function normalizeKeyToken(token) {
    const lower = token.toLowerCase();
    if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
    if (/^key[a-z]$/.test(lower)) return lower.slice(3); // KeyP → p
    if (/^digit[0-9]$/.test(lower)) return lower.slice(5); // Digit1 → 1
    return lower;
  }

  /**
   * 解析用户写的快捷键。key 为 null 表示只按修饰键（组合成立后快速点按触发）。
   * @returns {{ok: true, combo: {ctrl: boolean, alt: boolean, shift: boolean, meta: boolean, key: string|null}} | {ok: false, reason: string}}
   */
  function parseCombo(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return { ok: false, reason: "没有填写快捷键" };

    const tokens = text.split(/[\s+]+/).filter(Boolean);
    if (!tokens.length) return { ok: false, reason: `无法解析「${text}」` };

    const combo = { ctrl: false, alt: false, shift: false, meta: false, key: null };
    for (const token of tokens) {
      const mod = MOD_ALIASES[token.toLowerCase()];
      if (mod) {
        combo[mod] = true;
        continue;
      }
      if (combo.key !== null) return { ok: false, reason: `「${text}」里只能有一个主键` };
      combo.key = normalizeKeyToken(token);
      if (!combo.key) return { ok: false, reason: `无法识别主键「${token}」` };
    }
    if (combo.key === null && !combo.ctrl && !combo.alt && !combo.shift && !combo.meta) {
      return { ok: false, reason: `无法识别「${text}」` };
    }
    return { ok: true, combo };
  }

  function describeCombo(combo) {
    if (combo.key === null) {
      return [combo.ctrl && "Ctrl", combo.alt && "Alt", combo.shift && "Shift", combo.meta && "Meta"].filter(Boolean).join("+") + "（点按）";
    }
    return (
      [combo.ctrl && "Ctrl", combo.alt && "Alt", combo.shift && "Shift", combo.meta && "Meta"].filter(Boolean).join("+") +
      (combo.ctrl || combo.alt || combo.shift || combo.meta ? "+" : "") +
      (combo.key === " " ? "Space" : combo.key)
    );
  }

  function keyMatches(event, key) {
    const k = String(event.key || "").toLowerCase();
    if (k === key) return true;
    if (k === "process" || k === "unidentified" || k === "") return false; // 输入法组合中
    const code = String(event.code || "").toLowerCase();
    // 中文/非美式布局下 event.key 可能不是拉丁字符，退回到物理键位
    if (/^[a-z0-9]$/.test(key) && (code === "key" + key || code === "digit" + key)) return true;
    if (key === " " && code === "space") return true;
    return false;
  }

  function comboMatchesEvent(event, combo) {
    if (event.ctrlKey !== combo.ctrl) return false;
    if (event.altKey !== combo.alt) return false;
    if (event.shiftKey !== combo.shift) return false;
    if (event.metaKey !== combo.meta) return false;
    return keyMatches(event, combo.key);
  }

  function isPasswordField(el) {
    return !!el && el.nodeType === 1 && el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password";
  }

  function isRevealable(el) {
    if (!el || el.nodeType !== 1 || el.tagName !== "INPUT") return false;
    if (el.disabled || el.readOnly) return false;
    const type = (el.type || "").toLowerCase();
    if (type === "password") return true;
    return el.dataset.scReveal === "1" && (type === "text" || type === "");
  }

  function isVisibleNow(el) {
    return (el.type || "").toLowerCase() !== "password";
  }

  /** 焦点可能在 shadow root 里，顺着 activeElement 一直往下找。 */
  function deepActiveElement(root) {
    let el = root && root.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el || null;
  }

  let lastRevealable = null;

  function findTarget() {
    const active = deepActiveElement(document);
    if (isRevealable(active)) return active;

    // 焦点停在 shadow host 上时 activeElement 不会进入内部，再扫一遍打开的 shadow root
    const stack = [];
    const nodes = document.querySelectorAll("*");
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].shadowRoot) stack.push(nodes[i].shadowRoot);
    }
    const seen = new Set();
    while (stack.length) {
      const root = stack.pop();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      const inner = deepActiveElement(root);
      if (isRevealable(inner)) return inner;
      const innerNodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (let i = innerNodes.length - 1; i >= 0; i--) {
        if (innerNodes[i].shadowRoot) stack.push(innerNodes[i].shadowRoot);
      }
    }

    // 焦点可能被页面抢走（例如点到了按钮或浏览器界面），退回最近一次聚焦的密码框
    if (lastRevealable && lastRevealable.isConnected && isRevealable(lastRevealable)) return lastRevealable;
    return null;
  }

  function setVisible(input, visible) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const dir = input.selectionDirection;
    if (visible) {
      input.dataset.scReveal = "1";
      if (isPasswordField(input)) input.type = "text";
    } else {
      delete input.dataset.scReveal;
      if (!isPasswordField(input) && input.type !== "hidden" && input.type !== "email" && input.type !== "search") {
        input.type = "password";
      }
    }
    try {
      if (start != null && end != null) input.setSelectionRange(start, end, dir || "none");
    } catch (_) {
      /* 切换 type 后部分浏览器不允许恢复选区，忽略 */
    }
  }

  function toggleTarget(input) {
    const visible = isVisibleNow(input);
    setVisible(input, !visible);
    return !visible;
  }

  let toastEl = null;
  let toastTimer = 0;

  function showToast(input, text) {
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement("div");
      toastEl.setAttribute("data-sc-reveal-toast", "1");
      Object.assign(toastEl.style, {
        position: "fixed",
        zIndex: "2147483647",
        padding: "4px 8px",
        borderRadius: "6px",
        background: "rgba(20, 20, 20, 0.88)",
        color: "#fff",
        font: "12px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        pointerEvents: "none",
        boxShadow: "0 2px 8px rgba(0,0,0,.25)",
      });
      (document.documentElement || document.body).appendChild(toastEl);
    }
    const rect = input.getBoundingClientRect();
    toastEl.textContent = text;
    toastEl.style.display = "block";
    toastEl.style.top = Math.max(4, rect.top - 28) + "px";
    toastEl.style.left = Math.min(window.innerWidth - 72, Math.max(4, rect.left)) + "px";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.display = "none";
    }, 900);
  }

  // ---- 配置（支持保存后即时生效） ----
  const state = {
    combo: null,
    raw: "",
    hold: false,
    toast: true,
  };

  function toBool(value, fallback) {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    return fallback;
  }

  function notify(input, visible) {
    if (state.toast) showToast(input, visible ? "已显示" : "已隐藏");
  }

  function readConfig(initial) {
    const raw = String(GM_getValue("hotkey.combo", DEFAULT_COMBO) || "").trim();
    const parsed = parseCombo(raw);
    const fallback = parseCombo(DEFAULT_COMBO);

    if (parsed.ok) {
      state.combo = parsed.combo;
      state.raw = raw;
    } else {
      state.combo = fallback.combo;
      state.raw = raw;
      console.warn(
        `[reveal-password] ${REV} 快捷键「${raw || "(空)"}」无法使用：${parsed.reason}；已回退到 ${describeCombo(fallback.combo)}`
      );
    }
    state.hold = toBool(GM_getValue("hotkey.hold", false), false);
    state.toast = toBool(GM_getValue("hotkey.toast", true), true);

    if (!initial) {
      console.info(
        `[reveal-password] ${REV} 配置已更新：${describeCombo(state.combo)}，${state.hold ? "按住显示" : "点按切换"}`
      );
    }
  }

  readConfig(true);

  console.log(
    `[reveal-password] ${REV} 快捷键 ${describeCombo(state.combo)}，${state.hold ? "按住显示" : "点按切换"}`
  );

  // ---- 按键状态 ----
  const modsDown = new Set(); // 自己记录按下的修饰键，event.ctrlKey 在 keyup 时不可靠
  let chord = null; // 只按修饰键时的一次「点按」
  let heldInput = null; // 「按住才显示」正在显示的输入框

  let toggleLockUntil = 0; // 防止 keydown/keyup 双触发

  function chordIsComplete(combo) {
    const wanted =
      (combo.ctrl ? 1 : 0) + (combo.alt ? 1 : 0) + (combo.shift ? 1 : 0) + (combo.meta ? 1 : 0);
    if (modsDown.size !== wanted) return false;
    return (!combo.ctrl || modsDown.has("ctrl")) && (!combo.alt || modsDown.has("alt")) &&
      (!combo.shift || modsDown.has("shift")) && (!combo.meta || modsDown.has("meta"));
  }

  function hideHeld() {
    if (!heldInput) return;
    const input = heldInput;
    heldInput = null;
    if (input.isConnected) {
      setVisible(input, false);
      notify(input, false);
    }
  }

  function revealHeld(input) {
    heldInput = input;
    setVisible(input, true);
    notify(input, true);
  }

  function act(input) {
    if (state.hold) {
      revealHeld(input);
    } else {
      const nowVisible = toggleTarget(input);
      notify(input, nowVisible);
    }
  }

  function onKeyDown(event) {
    if (event.isComposing) return;
    const combo = state.combo;
    if (!combo) return;
    const mod = MOD_FROM_EVENT_KEY[String(event.key || "").toLowerCase()];

    if (combo.key === null) {
      // 只按修饰键：记录按下状态，等松开时判断是不是一次干净的点按
      if (mod) {
        modsDown.add(mod);
        if (!chord && chordIsComplete(combo)) {
          chord = { at: Date.now(), dirty: false, shown: false, timer: 0 };
          if (state.hold) {
            chord.timer = setTimeout(() => {
              if (!chord || chord.dirty) return;
              const input = findTarget();
              if (!input) {
                console.info(`[reveal-password] 按住了 ${describeCombo(combo)}，但没有聚焦的密码框`);
                return;
              }
              chord.shown = true;
              revealHeld(input);
            }, LONG_PRESS_MS);
          }
        } else if (chord) {
          chord.dirty = true;
        }
        return;
      }

      if (chord) {
        // 组合里又按了别的键：这是 Ctrl+C 之类的普通快捷键，不是点按
        chord.dirty = true;
        if (chord.shown) hideHeld();
      }
      return;
    }

    if (mod) return;
    if (!comboMatchesEvent(event, combo)) return;
    if (event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const input = findTarget();
    if (!input) {
      console.info(`[reveal-password] 按下了 ${describeCombo(combo)}，但没有聚焦的密码框`);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() < toggleLockUntil) return;
    if (!state.hold) toggleLockUntil = Date.now() + 80;
    act(input);
  }

  function finishChord() {
    if (!chord) return;
    const current = chord;
    chord = null;
    clearTimeout(current.timer);
    const elapsed = Date.now() - current.at;
    if (current.dirty) {
      if (current.shown) hideHeld();
      return;
    }
    if (state.hold) {
      if (current.shown) hideHeld();
      return; // 按住时间太短：按住模式下不响应
    }
    if (elapsed > TAP_MAX_MS) return;
    const input = findTarget();
    if (!input) {
      console.info(`[reveal-password] 按下了 ${describeCombo(state.combo)}，但没有聚焦的密码框`);
      return;
    }
    act(input);
  }

  function onKeyUp(event) {
    const combo = state.combo;
    if (!combo) return;
    const mod = MOD_FROM_EVENT_KEY[String(event.key || "").toLowerCase()];

    if (mod) {
      modsDown.delete(mod);
      if (chord && !chordIsComplete(combo)) finishChord();
      if (combo.key !== null && heldInput && combo[mod]) hideHeld();
      return;
    }

    if (combo.key === null) return;
    if (heldInput && keyMatches(event, combo.key)) hideHeld();
  }

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);

  window.addEventListener(
    "blur",
    () => {
      modsDown.clear();
      if (chord) {
        clearTimeout(chord.timer);
        chord = null;
      }
      if (heldInput) {
        const input = heldInput;
        heldInput = null;
        setVisible(input, false);
      }
    },
    true
  );

  // 只按修饰键时，配合鼠标操作（Ctrl+点击选词等）不应算作点按
  document.addEventListener(
    "mousedown",
    () => {
      if (!chord) return;
      chord.dirty = true;
      if (chord.shown) hideHeld();
    },
    true
  );

  // 记录最近一次聚焦的可切换输入框；顺便清掉网站重置 type 后残留的标记
  document.addEventListener(
    "focusin",
    (event) => {
      const el = event.composedPath ? event.composedPath()[0] : event.target;
      if (isRevealable(el)) lastRevealable = el;
    },
    true
  );

  document.addEventListener(
    "input",
    (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1 || el.tagName !== "INPUT") return;
      if (isPasswordField(el) && el.dataset.scReveal === "1") delete el.dataset.scReveal;
    },
    true
  );

  // 设置面板保存后立即生效，不必刷新页面
  GM_addValueChangeListener("hotkey.combo", () => readConfig(false));
  GM_addValueChangeListener("hotkey.hold", () => readConfig(false));
  GM_addValueChangeListener("hotkey.toast", () => readConfig(false));

  GM_registerMenuCommand("显示密码设置", () => {
    CAT_userConfig();
  });
})();
