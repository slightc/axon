// ==UserScript==
// @name         Axon Device
// @namespace    https://github.com/slightc/axon
// @version      0.4.0
// @description  把当前页面变成一台 Axon 设备：agent 可远程下发代码控制本页面。支持 client key（归属账号）与 legacy（device id）两种模式。
// @author       Hans
// @match        *://*/*
// @exclude      https://axon.hansc.workers.dev/*
// @grant        none
// @run-at       document-idle
// @noframes
// @downloadURL  https://axon.hansc.workers.dev/axon.user.js
// @updateURL    https://axon.hansc.workers.dev/axon.user.js
// ==/UserScript==

(function () {
  "use strict";

  // ===== 改成你自己的 axon worker 域名 =====
  const AXON_HOST = "axon.hansc.workers.dev";
  // =======================================

  if (window.top !== window.self) return;            // 只在顶层窗口注入
  if (location.host === AXON_HOST) return;            // 不注入 axon 自己的页面（设备页面已是设备，避免同 id 互踢）

  const LS = {
    get key() { return localStorage.getItem("axon_client_key") || ""; },
    set key(v) { v ? localStorage.setItem("axon_client_key", v) : localStorage.removeItem("axon_client_key"); },
    get name() { return localStorage.getItem("axon_name") || ""; },
    set name(v) { v ? localStorage.setItem("axon_name", v) : localStorage.removeItem("axon_name"); },
  };

  function randomId(len) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const arr = new Uint8Array(len); crypto.getRandomValues(arr);
    return Array.from(arr, (b) => chars[b % chars.length]).join("");
  }
  function getDeviceId() {
    let id = localStorage.getItem("axon_device_id");
    if (!id) { id = "dev_" + randomId(32); try { localStorage.setItem("axon_device_id", id); } catch {} }
    return id;
  }
  const deviceId = getDeviceId();
  let assignedName = LS.name;

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    if (LS.key) {
      const p = new URLSearchParams({ key: LS.key, type: "browser", id: deviceId });
      if (LS.name) p.set("name", LS.name);
      return `${proto}://${AXON_HOST}/connect?${p.toString()}`;
    }
    return `${proto}://${AXON_HOST}/connect?id=${encodeURIComponent(deviceId)}`;
  }

  // ---------- 执行 agent 下发的代码 ----------
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  function serialize(v) {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
    if (v instanceof Node) return `[${v.nodeName}${v.id ? " #" + v.id : ""}]`;
    try {
      const seen = new WeakSet();
      return JSON.stringify(v, (k, val) => {
        if (typeof val === "object" && val !== null) { if (seen.has(val)) return "[Circular]"; seen.add(val); if (val instanceof Node) return `[${val.nodeName}]`; }
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
    try { const ret = await new AsyncFunction(code)(); return { ok: true, result: serialize(ret), logs }; }
    catch (e) { return { ok: false, error: String((e && e.stack) || e), logs }; }
    finally { Object.assign(console, orig); }
  }

  // ---------- 连接 ----------
  let ws = null, manualClose = false, reconnectTimer = null, pingTimer = null;
  function connect() {
    manualClose = false;
    try { localStorage.setItem("axon_autoconnect", "1"); } catch {}
    setState("connecting");
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      setState("online");
      ws.send(JSON.stringify({ type: "hello", info: { ua: navigator.userAgent, url: location.href, title: document.title } }));
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" })); }, 30000);
    };
    ws.onmessage = async (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === "welcome") { assignedName = msg.name; renderMeta(); return; }
      if (msg.type !== "exec") return;
      const res = await runCode(msg.code);
      bumpCount();
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "result", reqId: msg.reqId, ...res }));
    };
    ws.onclose = (e) => {
      clearInterval(pingTimer);
      // 被新连接顶替（同 device id 已有连接）→ 不重连，避免无限互踢
      if (manualClose || (e && e.reason === "replaced")) {
        manualClose = true;
        try { localStorage.removeItem("axon_autoconnect"); } catch {}
        setState("offline");
        if (e && e.reason === "replaced" && stateEl) stateEl.textContent = "已被新连接取代";
        return;
      }
      setState("reconnect");
      reconnectTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  function disconnect() {
    manualClose = true;
    try { localStorage.removeItem("axon_autoconnect"); } catch {}
    clearTimeout(reconnectTimer); clearInterval(pingTimer);
    try { ws && ws.close(1000, "manual"); } catch {}
    ws = null; setState("offline");
  }

  // ---------- 悬浮 UI（默认收起的小球，可拖动，吸附左右边）----------
  function loadPos() { try { return JSON.parse(localStorage.getItem("axon_ui")) || null; } catch { return null; } }
  function savePos(p) { try { localStorage.setItem("axon_ui", JSON.stringify(p)); } catch {} }
  let pos = loadPos() || { side: "right", top: Math.max(8, innerHeight - 90) };

  const root = document.createElement("div");
  root.setAttribute("style", "position:fixed;z-index:2147483647;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;touch-action:none");
  root.innerHTML = `
    <div id="axon-panel" style="display:none;width:250px;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden">
      <div id="axon-head" style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0d1117;border-bottom:1px solid #30363d;cursor:grab">
        <span style="font-weight:700">🧠 Axon</span>
        <span id="axon-dot" style="width:9px;height:9px;border-radius:50%;background:#8b949e"></span>
        <span id="axon-state" style="color:#8b949e;flex:1">未连接</span>
        <span id="axon-gear" style="cursor:pointer;color:#8b949e;padding:0 3px" title="设置">⚙</span>
        <span id="axon-min" style="cursor:pointer;color:#8b949e;padding:0 3px" title="收起">—</span>
      </div>
      <div id="axon-cfg" style="display:none;padding:12px;border-bottom:1px solid #30363d;background:#0d1117">
        <div style="color:#8b949e;font-size:11px;margin-bottom:3px">Client Key（留空则 legacy 模式）</div>
        <input id="axon-key" placeholder="ck_..." style="width:100%;box-sizing:border-box;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:7px;font:12px ui-monospace;margin-bottom:8px">
        <div style="color:#8b949e;font-size:11px;margin-bottom:3px">设备名（可选，重名服务端会改）</div>
        <input id="axon-nm" placeholder="如 my-laptop" style="width:100%;box-sizing:border-box;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:7px;font:12px ui-monospace;margin-bottom:10px">
        <button id="axon-save" style="width:100%;padding:8px;border:none;border-radius:6px;background:#238636;color:#fff;font-weight:600;cursor:pointer">保存并重连</button>
      </div>
      <div style="padding:12px">
        <div id="axon-meta" style="font-size:11px;color:#8b949e;margin-bottom:8px"></div>
        <div id="axon-id" style="color:#58a6ff;word-break:break-all;cursor:pointer;margin-bottom:10px;font-size:11px" title="复制设备 ID">${deviceId}</div>
        <div style="display:flex;gap:8px;align-items:center">
          <button id="axon-btn" style="flex:1;padding:9px;border:none;border-radius:7px;background:#238636;color:#fff;font-weight:600;cursor:pointer;font-size:13px">开始连接</button>
          <span id="axon-count" style="color:#8b949e;font-size:11px">0 次</span>
        </div>
      </div>
    </div>
    <div id="axon-fab" style="width:40px;height:40px;border-radius:50%;background:#161b22;border:1px solid #30363d;box-shadow:0 6px 24px rgba(0,0,0,.5);cursor:grab;display:flex;align-items:center;justify-content:center;font-size:18px;position:relative">
      🧠<span id="axon-fab-dot" style="position:absolute;top:2px;right:2px;width:8px;height:8px;border-radius:50%;background:#8b949e;border:1.5px solid #161b22"></span>
    </div>`;
  (document.body || document.documentElement).appendChild(root);

  const $ = (s) => root.querySelector(s);
  const dot = $("#axon-dot"), stateEl = $("#axon-state"), btn = $("#axon-btn"), countEl = $("#axon-count");
  const panel = $("#axon-panel"), fab = $("#axon-fab"), fabDot = $("#axon-fab-dot"), cfgBox = $("#axon-cfg"), metaEl = $("#axon-meta");
  let count = 0;
  const bumpCount = () => { count++; countEl.textContent = count + " 次"; };

  function applyPos() {
    root.style.top = pos.top + "px"; root.style.bottom = "auto";
    root.style.left = pos.side === "left" ? "12px" : "auto";
    root.style.right = pos.side === "right" ? "12px" : "auto";
  }
  applyPos();

  function renderMeta() { metaEl.textContent = LS.key ? `账号模式 · ${assignedName || LS.name || "(待分配名)"}` : "legacy 模式（device id 直接访问）"; }
  function setState(s) {
    const map = { connecting: ["#d29922", "连接中…", "断开", "#6e2630"], online: ["#3fb950", "在线", "断开", "#6e2630"], reconnect: ["#d29922", "重连中…", "断开", "#6e2630"], offline: ["#8b949e", "未连接", "开始连接", "#238636"] };
    const [c, t, label, bg] = map[s] || map.offline;
    dot.style.background = c; stateEl.textContent = t; fabDot.style.background = c;
    btn.textContent = label; btn.style.background = bg; btn.dataset.on = s === "offline" ? "0" : "1";
  }

  // 拖动 + 吸附左右边。handle 上没移动则当点击。
  function draggable(handle, onClick) {
    let down = false, moved = false, sy = 0, st = 0;
    handle.addEventListener("pointerdown", (e) => { down = true; moved = false; sy = e.clientY; st = root.offsetTop; try { handle.setPointerCapture(e.pointerId); } catch {} });
    handle.addEventListener("pointermove", (e) => { if (!down) return; const dy = e.clientY - sy; if (Math.abs(dy) > 4) { moved = true; handle.style.cursor = "grabbing"; } root.style.top = Math.max(8, Math.min(innerHeight - 48, st + dy)) + "px"; root.style.bottom = "auto"; });
    const end = (e) => {
      if (!down) return; down = false; handle.style.cursor = "grab";
      pos.top = root.offsetTop;
      const cx = root.getBoundingClientRect().left + root.offsetWidth / 2;
      pos.side = cx < innerWidth / 2 ? "left" : "right";
      applyPos(); savePos(pos);
      if (!moved && onClick) onClick();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function openPanel() { fab.style.display = "none"; panel.style.display = ""; applyPos(); }
  function closePanel() { panel.style.display = "none"; fab.style.display = "flex"; applyPos(); }

  draggable(fab, openPanel);          // 小球：拖动移动位置，点击展开
  draggable($("#axon-head"), null);   // 面板标题栏：可拖动

  $("#axon-key").value = LS.key; $("#axon-nm").value = LS.name;
  btn.onclick = () => { btn.dataset.on === "1" ? disconnect() : connect(); };
  $("#axon-gear").onclick = (e) => { e.stopPropagation(); cfgBox.style.display = cfgBox.style.display === "none" ? "" : "none"; };
  $("#axon-save").onclick = () => { LS.key = $("#axon-key").value.trim(); LS.name = $("#axon-nm").value.trim(); assignedName = LS.name; cfgBox.style.display = "none"; renderMeta(); disconnect(); connect(); };
  $("#axon-id").onclick = () => { navigator.clipboard?.writeText(deviceId); const el = $("#axon-id"), o = el.textContent; el.textContent = "已复制 ✓"; setTimeout(() => (el.textContent = o), 1000); };
  $("#axon-min").onclick = (e) => { e.stopPropagation(); closePanel(); };

  renderMeta();
  setState("offline");
  // 默认收起成小球；之前开启过连接则自动续连（仍保持收起）
  if (localStorage.getItem("axon_autoconnect") === "1") connect();
})();
