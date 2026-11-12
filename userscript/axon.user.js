// ==UserScript==
// @name         Axon Device
// @namespace    https://github.com/slightc/axon
// @version      0.2.0
// @description  把当前页面变成一台 Axon 设备：点「开始连接」后 agent 可远程下发代码控制本页面；可随时断开。
// @author       Hans
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // ===== 配置：改成你自己的 axon worker 域名 =====
  const AXON_HOST = "axon.hansc.workers.dev";
  // ============================================

  if (window.top !== window.self) return; // 只在顶层窗口注入

  // 高熵、不可暴力猜测的设备 id（dev_ + 32 字符 base62 ≈ 190 bit），按 origin 持久化
  function randomId(len) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => chars[b % chars.length]).join("");
  }
  function getDeviceId() {
    let id = localStorage.getItem("axon_device_id");
    if (!id) { id = "dev_" + randomId(32); try { localStorage.setItem("axon_device_id", id); } catch {} }
    return id;
  }

  const deviceId = getDeviceId();
  const wsUrl = `wss://${AXON_HOST}/connect?id=${encodeURIComponent(deviceId)}`;

  let ws = null;
  let manualClose = false;
  let reconnectTimer = null;
  let pingTimer = null;

  // ---------- 执行 agent 下发的代码（运行在本页面上下文，可直接操作真实 DOM） ----------
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  function serialize(v) {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
    if (v instanceof Node) return `[${v.nodeName}${v.id ? " #" + v.id : ""}]`;
    try {
      const seen = new WeakSet();
      return JSON.stringify(v, (k, val) => {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
          if (val instanceof Node) return `[${val.nodeName}]`;
        }
        if (typeof val === "function") return "[Function]";
        return val;
      }, 2);
    } catch { return String(v); }
  }
  async function runCode(code) {
    const logs = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    const cap = (fn, lv) => (...a) => { logs.push(`[${lv}] ` + a.map((x) => typeof x === "object" ? serialize(x) : String(x)).join(" ")); fn.apply(console, a); };
    console.log = cap(orig.log, "log"); console.warn = cap(orig.warn, "warn"); console.error = cap(orig.error, "error");
    try {
      const ret = await new AsyncFunction(code)();
      return { ok: true, result: serialize(ret), logs };
    } catch (e) {
      return { ok: false, error: String((e && e.stack) || e), logs };
    } finally {
      Object.assign(console, orig);
    }
  }

  // ---------- 连接 ----------
  function connect() {
    manualClose = false;
    try { localStorage.setItem("axon_autoconnect", "1"); } catch {}
    setState("connecting");
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      setState("online");
      ws.send(JSON.stringify({ type: "hello", info: { ua: navigator.userAgent, url: location.href, title: document.title } }));
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" })); }, 30000);
    };
    ws.onmessage = async (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type !== "exec") return;
      const res = await runCode(msg.code);
      bumpCount();
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "result", reqId: msg.reqId, ...res }));
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (manualClose) { setState("offline"); return; }
      setState("reconnect");
      reconnectTimer = setTimeout(connect, 3000); // 意外断开自动重连
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  function disconnect() {
    manualClose = true;
    try { localStorage.removeItem("axon_autoconnect"); } catch {}
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);
    try { ws && ws.close(1000, "manual"); } catch {}
    ws = null;
    setState("offline");
  }

  // ---------- 悬浮 UI（全内联样式，避免被页面 CSS 污染） ----------
  const box = "position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace";
  const root = document.createElement("div");
  root.setAttribute("style", box);
  root.innerHTML = `
    <div id="axon-panel" style="width:230px;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden">
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0d1117;border-bottom:1px solid #30363d">
        <span style="font-weight:700">🧠 Axon</span>
        <span id="axon-dot" style="width:9px;height:9px;border-radius:50%;background:#8b949e"></span>
        <span id="axon-state" style="color:#8b949e;flex:1">未连接</span>
        <span id="axon-min" style="cursor:pointer;color:#8b949e;padding:0 4px" title="收起">—</span>
      </div>
      <div id="axon-body" style="padding:12px">
        <div style="color:#8b949e;font-size:11px;margin-bottom:4px">设备 ID（点击复制）</div>
        <div id="axon-id" style="color:#58a6ff;word-break:break-all;cursor:pointer;margin-bottom:10px" title="复制设备 ID">${deviceId}</div>
        <div style="display:flex;gap:8px;align-items:center">
          <button id="axon-btn" style="flex:1;padding:9px;border:none;border-radius:7px;background:#238636;color:#fff;font-weight:600;cursor:pointer;font-size:13px">开始连接</button>
          <span id="axon-count" style="color:#8b949e;font-size:11px">0 次</span>
        </div>
      </div>
    </div>
    <div id="axon-fab" style="display:none;width:44px;height:44px;border-radius:50%;background:#161b22;border:1px solid #30363d;box-shadow:0 8px 30px rgba(0,0,0,.5);cursor:pointer;align-items:center;justify-content:center;font-size:20px">🧠</div>`;
  (document.body || document.documentElement).appendChild(root);

  const $ = (id) => root.querySelector(id);
  const dot = $("#axon-dot"), stateEl = $("#axon-state"), btn = $("#axon-btn"), countEl = $("#axon-count");
  const panel = $("#axon-panel"), fab = $("#axon-fab");
  let count = 0;
  function bumpCount() { count++; countEl.textContent = count + " 次"; }

  function setState(s) {
    const map = {
      connecting: ["#d29922", "连接中…", "断开", "#6e2630"],
      online:     ["#3fb950", "在线",    "断开", "#6e2630"],
      reconnect:  ["#d29922", "重连中…", "断开", "#6e2630"],
      offline:    ["#8b949e", "未连接",  "开始连接", "#238636"],
    };
    const [c, t, label, bg] = map[s] || map.offline;
    dot.style.background = c; stateEl.textContent = t;
    btn.textContent = label; btn.style.background = bg;
    btn.dataset.on = (s === "offline") ? "0" : "1";
  }

  btn.onclick = () => { (btn.dataset.on === "1") ? disconnect() : connect(); };
  $("#axon-id").onclick = () => {
    navigator.clipboard?.writeText(deviceId);
    const el = $("#axon-id"), old = el.textContent;
    el.textContent = "已复制 ✓"; setTimeout(() => (el.textContent = old), 1000);
  };
  $("#axon-min").onclick = () => { panel.style.display = "none"; fab.style.display = "flex"; };
  fab.onclick = () => { fab.style.display = "none"; panel.style.display = ""; };

  setState("offline");
  // 跨页面保持：之前开启过连接，则页面（含导航后的新页面）加载时自动续连，支持多步任务
  if (localStorage.getItem("axon_autoconnect") === "1") connect();
})();
