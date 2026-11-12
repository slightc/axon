/**
 * Axon worker
 *
 * 两条路径并存：
 *  - Legacy（兼容旧设备）：/connect?id= · /exec?id=（AGENT_TOKEN）· /status?id=  → DeviceSession
 *  - 多用户：/connect?key=<client_key>&name=&type=&id=  → UserHub（按 client key 定位用户）
 *           /agent/devices · /agent/exec?device=<name|id>（agent key）→ UserHub
 */

import { signJWT, verifyJWT, setCookie, getCookie, requireUser, githubAuthUrl, githubExchange, githubUser, upsertGithubUser } from "./auth.js";
import { protectedResourceMetadata, authServerMetadata, handleRegister, handleAuthorizeGet, handleAuthorizePost, handleToken, oauthPreflight } from "./oauth.js";

// ===== Legacy：一台设备一个 DeviceSession（旧随机 id + AGENT_TOKEN，保持兼容）=====
export class DeviceSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.deviceSocket = null;
    this.pending = new Map();
    this.meta = { connectedAt: null, ua: null, info: null };
  }

  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/connect": return this.handleConnect(request);
      case "/exec":    return this.handleExec(request);
      case "/status":  return Response.json({ online: !!this.deviceSocket, meta: this.meta });
      default:         return new Response("not found", { status: 404 });
    }
  }

  handleConnect(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    if (this.deviceSocket) { try { this.deviceSocket.close(1000, "replaced"); } catch {} }
    this.deviceSocket = server;
    this.meta.connectedAt = Date.now();
    this.meta.ua = request.headers.get("user-agent");

    server.addEventListener("message", (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      const p = this.pending.get(msg.reqId);
      if (msg.type === "stream") {
        if (p && p.stream && !p.closed) {
          try { p.controller.enqueue(p.enc.encode(JSON.stringify({ t: msg.stream, d: msg.data }) + "\n")); } catch {}
        }
      } else if (msg.type === "result") {
        if (!p) return;
        if (p.stream) {
          if (!p.closed) {
            p.closed = true; clearTimeout(p.timer);
            try { p.controller.enqueue(p.enc.encode(JSON.stringify({ t: "end", ok: msg.ok, exitCode: msg.exitCode ?? null, error: msg.error ?? null }) + "\n")); } catch {}
            try { p.controller.close(); } catch {}
          }
          this.pending.delete(msg.reqId);
        } else {
          clearTimeout(p.timer); this.pending.delete(msg.reqId); p.resolve(msg);
        }
      } else if (msg.type === "hello") {
        this.meta.info = msg.info || null;
      } else if (msg.type === "ping") {
        try { server.send(JSON.stringify({ type: "pong" })); } catch {}
      }
    });

    const drop = () => { if (this.deviceSocket === server) this.deviceSocket = null; };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleExec(request) {
    if (!this.deviceSocket) return Response.json({ ok: false, error: "device offline" }, { status: 503 });
    const url = new URL(request.url);
    const streaming = url.searchParams.get("stream") === "1";
    const code = await request.text();
    if (!code.trim()) return Response.json({ ok: false, error: "empty code" }, { status: 400 });
    const reqId = crypto.randomUUID();
    if (streaming) return streamExec(this, this.deviceSocket, reqId, code, (id) => this.pending.delete(id), this.pending);
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); resolve({ ok: false, error: "timeout (15s)" }); }, 15000);
      this.pending.set(reqId, { resolve, timer });
      try { this.deviceSocket.send(JSON.stringify({ type: "exec", reqId, code })); }
      catch (e) { clearTimeout(timer); this.pending.delete(reqId); resolve({ ok: false, error: "send failed: " + e.message }); }
    });
    return Response.json(result);
  }
}

// ===== 多用户：UserHub（每个用户一个 DO，持有其所有在线设备，给 agent 路由）=====
export class UserHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.userId = null;
    this.devices = new Map();   // deviceId -> { ws, deviceId, name, type, meta, connectedAt, clientKey }
    this.pending = new Map();   // reqId -> agent 请求（含流式）
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.searchParams.get("uid")) this.userId = url.searchParams.get("uid");
    switch (url.pathname) {
      case "/hub/connect": return this.handleDeviceConnect(request, url);
      case "/hub/devices": return this.handleListDevices();
      case "/hub/exec":    return this.handleExec(request, url);
      default:             return new Response("not found", { status: 404 });
    }
  }

  // 同一用户下在线设备 name 去重：重名则加 -2 / -3…；不传 name 则按 type 生成
  resolveName(wanted, type, selfId) {
    const taken = new Set();
    for (const [id, d] of this.devices) if (id !== selfId) taken.add(d.name);
    let base = (wanted && wanted.trim()) ? wanted.trim() : `${type || "device"}-${selfId.slice(-4)}`;
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  }

  // 按 device id 精确匹配，否则按 name
  findDevice(target) {
    if (this.devices.has(target)) return this.devices.get(target);
    for (const d of this.devices.values()) if (d.name === target) return d;
    return null;
  }

  handleDeviceConnect(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const deviceId = (url.searchParams.get("id") || "").match(/^[A-Za-z0-9_-]{8,128}$/)
      ? url.searchParams.get("id") : ("dev_" + randomId(32));
    const type = (url.searchParams.get("type") || "device").slice(0, 32);
    const wantedName = (url.searchParams.get("name") || "").slice(0, 64);
    const clientKey = url.searchParams.get("key") || null;

    const old = this.devices.get(deviceId);
    if (old) { try { old.ws.close(1000, "replaced"); } catch {} this.devices.delete(deviceId); }

    const name = this.resolveName(wantedName, type, deviceId);
    const rec = { ws: server, deviceId, name, type, meta: null, connectedAt: Date.now(), clientKey };
    this.devices.set(deviceId, rec);

    server.addEventListener("message", (evt) => this.routeMessage(evt, rec));
    const drop = () => { if (this.devices.get(deviceId) === rec) this.devices.delete(deviceId); };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    // 告知设备最终身份（name 可能被服务端改过）
    try { server.send(JSON.stringify({ type: "welcome", deviceId, name })); } catch {}
    this.upsertDevice(rec);

    return new Response(null, { status: 101, webSocket: client });
  }

  routeMessage(evt, rec) {
    let msg; try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.type === "hello") { rec.meta = msg.info || null; this.upsertDevice(rec); return; }
    if (msg.type === "ping") { try { rec.ws.send(JSON.stringify({ type: "pong" })); } catch {} return; }
    const p = this.pending.get(msg.reqId);
    if (!p) return;
    if (msg.type === "stream") {
      if (p.stream && !p.closed) { try { p.controller.enqueue(p.enc.encode(JSON.stringify({ t: msg.stream, d: msg.data }) + "\n")); } catch {} }
    } else if (msg.type === "result") {
      if (p.stream) {
        if (!p.closed) {
          p.closed = true; clearTimeout(p.timer);
          try { p.controller.enqueue(p.enc.encode(JSON.stringify({ t: "end", ok: msg.ok, exitCode: msg.exitCode ?? null, error: msg.error ?? null }) + "\n")); } catch {}
          try { p.controller.close(); } catch {}
        }
        this.pending.delete(msg.reqId);
      } else { clearTimeout(p.timer); this.pending.delete(msg.reqId); p.resolve(msg); }
    }
  }

  handleListDevices() {
    const now = Date.now();
    const list = [...this.devices.values()].map((d) => ({
      deviceId: d.deviceId, name: d.name, type: d.type, meta: d.meta,
      connectedAt: d.connectedAt, onlineMs: now - d.connectedAt,
    }));
    return Response.json({ count: list.length, devices: list });
  }

  async handleExec(request, url) {
    const target = url.searchParams.get("device") || "";
    const dev = this.findDevice(target);
    if (!dev) return Response.json({ ok: false, error: `device not found: ${target || "(empty)"}`, online: [...this.devices.values()].map((d) => d.name) }, { status: 404 });
    const streaming = url.searchParams.get("stream") === "1";
    const code = await request.text();
    if (!code.trim()) return Response.json({ ok: false, error: "empty code" }, { status: 400 });
    const reqId = crypto.randomUUID();
    if (streaming) return streamExec(this, dev.ws, reqId, code, (id) => this.pending.delete(id), this.pending);
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); resolve({ ok: false, error: "timeout (15s)" }); }, 15000);
      this.pending.set(reqId, { resolve, timer });
      try { dev.ws.send(JSON.stringify({ type: "exec", reqId, code })); }
      catch (e) { clearTimeout(timer); this.pending.delete(reqId); resolve({ ok: false, error: "send failed: " + e.message }); }
    });
    return Response.json({ device: { id: dev.deviceId, name: dev.name }, ...result });
  }

  async upsertDevice(rec) {
    if (!this.userId || !this.env.DB) return;
    const now = Date.now();
    try {
      await this.env.DB.prepare(
        `INSERT INTO devices (id, user_id, name, type, client_key, meta, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, meta=excluded.meta, last_seen=excluded.last_seen`
      ).bind(rec.deviceId, this.userId, rec.name, rec.type, rec.clientKey, rec.meta ? JSON.stringify(rec.meta) : null, now, now).run();
    } catch {}
  }
}

// 流式 exec：公用给 DeviceSession 与 UserHub。返回一条 NDJSON 响应流。
function streamExec(_self, ws, reqId, code, del, pending) {
  const enc = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      const entry = { stream: true, controller, enc, closed: false };
      entry.timer = setTimeout(() => {
        if (entry.closed) return; entry.closed = true;
        try { controller.enqueue(enc.encode(JSON.stringify({ t: "end", error: "timeout (10min)" }) + "\n")); } catch {}
        try { controller.close(); } catch {}
        del(reqId);
        try { ws.send(JSON.stringify({ type: "cancel", reqId })); } catch {}
      }, 10 * 60 * 1000);
      pending.set(reqId, entry);
      try { ws.send(JSON.stringify({ type: "exec", reqId, code, stream: true })); }
      catch (e) {
        entry.closed = true; clearTimeout(entry.timer);
        try { controller.enqueue(enc.encode(JSON.stringify({ t: "end", error: "send failed: " + e.message }) + "\n")); } catch {}
        try { controller.close(); } catch {} del(reqId);
      }
    },
    cancel() {
      const entry = pending.get(reqId);
      if (entry) { entry.closed = true; clearTimeout(entry.timer); del(reqId); }
      try { ws.send(JSON.stringify({ type: "cancel", reqId })); } catch {}
    },
  });
  return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- 多用户：client key 设备连接 ---
    if (path === "/connect" && url.searchParams.get("key")) {
      const uid = await userIdForKey(env, "client_keys", url.searchParams.get("key"), ctx);
      if (!uid) return new Response("invalid client key", { status: 401 });
      return hubFetch(env, uid, request, url, "/hub/connect");
    }

    // --- 多用户：agent 列出在线设备 ---
    if (path === "/agent/devices" && request.method === "GET") {
      const uid = await userIdForAgentKey(env, request, ctx);
      if (!uid) return new Response("unauthorized", { status: 401 });
      return hubFetch(env, uid, request, url, "/hub/devices");
    }

    // --- 多用户：agent 对指定设备 exec（device = name 或 id）---
    if (path === "/agent/exec" && request.method === "POST") {
      const uid = await userIdForAgentKey(env, request, ctx);
      if (!uid) return new Response("unauthorized", { status: 401 });
      return hubFetch(env, uid, request, url, "/hub/exec");
    }

    // --- Agent MCP（Streamable HTTP，agent key 鉴权）---
    if (path === "/mcp" && request.method === "POST") {
      const uid = await userIdForAgentKey(env, request, ctx);
      if (!uid) {
        const o = env.PUBLIC_ORIGIN || url.origin;
        return new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${o}/.well-known/oauth-protected-resource"` } });
      }
      return handleMcp(await request.json().catch(() => ({})), uid, env);
    }
    if (path === "/mcp") return new Response("MCP endpoint: POST JSON-RPC with header Authorization: Bearer <agent_key>", { status: 405 });

    // ===== MCP OAuth：发现 / 动态注册 / 授权 / 令牌 =====
    if (path === "/.well-known/oauth-protected-resource" || path.startsWith("/.well-known/oauth-protected-resource/")) {
      if (request.method === "OPTIONS") return oauthPreflight();
      return protectedResourceMetadata(env, request);
    }
    if (path === "/.well-known/oauth-authorization-server" || path.startsWith("/.well-known/oauth-authorization-server/")) {
      if (request.method === "OPTIONS") return oauthPreflight();
      return authServerMetadata(env, request);
    }
    if (path === "/register") return handleRegister(request, env);
    if (path === "/authorize" && request.method === "GET") return handleAuthorizeGet(request, env, url);
    if (path === "/authorize" && request.method === "POST") return handleAuthorizePost(request, env);
    if (path === "/token") return handleToken(request, env);

    // --- Legacy：/connect?id= · /exec?id= · /status?id= ---
    if (path === "/connect") {
      const id = getDeviceId(url);
      if (!id) return new Response("invalid device id", { status: 400 });
      return stubFor(env, id).fetch(request);
    }
    if (path === "/exec" && request.method === "POST") {
      const unauth = checkAuth(request, env);
      if (unauth) return unauth;
      const id = getDeviceId(url);
      if (!id) return new Response("invalid device id", { status: 400 });
      return stubFor(env, id).fetch(request);
    }
    if (path === "/status") {
      const id = getDeviceId(url);
      if (!id) return Response.json({ online: false, error: "invalid device id" }, { status: 400 });
      return stubFor(env, id).fetch(request);
    }

    // ===== Auth（GitHub OAuth）=====
    if (path === "/auth/github") {
      const state = randomId(16);
      const headers = new Headers({ Location: githubAuthUrl(env, request, state) });
      headers.append("Set-Cookie", setCookie("axon_oauth_state", state, 600));
      return new Response(null, { status: 302, headers });
    }
    if (path === "/auth/github/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state || state !== getCookie(request, "axon_oauth_state")) return new Response("invalid oauth state", { status: 400 });
      const tok = await githubExchange(env, request, code);
      if (!tok) return new Response("oauth exchange failed", { status: 400 });
      const gh = await githubUser(tok);
      if (!gh) return new Response("github user fetch failed", { status: 400 });
      const uid = await upsertGithubUser(env, gh, randomId);
      const jwt = await signJWT({ uid, exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 }, env.JWT_SECRET);
      // 若是 OAuth 授权流程中途来登录的，回跳到原 /authorize；否则进面板
      let dest = "/panel";
      const rt = getCookie(request, "axon_return_to");
      if (rt) { try { const d = decodeURIComponent(rt); if (d.startsWith("/authorize")) dest = d; } catch {} }
      const headers = new Headers({ Location: dest });
      headers.append("Set-Cookie", setCookie("axon_session", jwt, 30 * 24 * 3600));
      headers.append("Set-Cookie", setCookie("axon_oauth_state", "", 0));
      headers.append("Set-Cookie", setCookie("axon_return_to", "", 0));
      return new Response(null, { status: 302, headers });
    }
    if (path === "/auth/logout") {
      const headers = new Headers({ Location: "/" });
      headers.append("Set-Cookie", setCookie("axon_session", "", 0));
      return new Response(null, { status: 302, headers });
    }

    // ===== 面板 API（JWT session）=====
    if (path === "/api/me") {
      const uid = await requireUser(request, env);
      if (!uid) return Response.json({ user: null }, { status: 401 });
      const u = await env.DB.prepare("SELECT id,provider,name,email,avatar,created_at FROM users WHERE id=?").bind(uid).first();
      return Response.json({ user: u });
    }
    if (path === "/api/devices" && request.method === "GET") {
      const uid = await requireUser(request, env);
      if (!uid) return json401();
      const rows = await env.DB.prepare("SELECT id,name,type,meta,first_seen,last_seen FROM devices WHERE user_id=? ORDER BY last_seen DESC").bind(uid).all();
      let onlineIds = new Set();
      try {
        const o = await hubFor(env, uid).fetch(new Request(`https://x/hub/devices?uid=${uid}`)).then((r) => r.json());
        onlineIds = new Set((o.devices || []).map((d) => d.deviceId));
      } catch {}
      const devices = (rows.results || []).map((d) => ({ id: d.id, name: d.name, type: d.type, meta: safeJSON(d.meta), firstSeen: d.first_seen, lastSeen: d.last_seen, online: onlineIds.has(d.id) }));
      return Response.json({ devices });
    }
    if (path.startsWith("/api/devices/") && request.method === "PATCH") {
      const uid = await requireUser(request, env);
      if (!uid) return json401();
      const id = decodeURIComponent(path.slice("/api/devices/".length));
      const body = await request.json().catch(() => ({}));
      const sets = [], binds = [];
      if (typeof body.name === "string") { sets.push("name=?"); binds.push(body.name.slice(0, 64)); }
      if (typeof body.type === "string") { sets.push("type=?"); binds.push(body.type.slice(0, 32)); }
      if (!sets.length) return Response.json({ error: "nothing to update" }, { status: 400 });
      binds.push(id, uid);
      const r = await env.DB.prepare(`UPDATE devices SET ${sets.join(",")} WHERE id=? AND user_id=?`).bind(...binds).run();
      return Response.json({ ok: r.meta.changes > 0 });
    }
    if (path === "/api/keys" && request.method === "GET") {
      const uid = await requireUser(request, env);
      if (!uid) return json401();
      const ck = await env.DB.prepare("SELECT key,label,created_at,last_used FROM client_keys WHERE user_id=? ORDER BY created_at DESC").bind(uid).all();
      const ak = await env.DB.prepare("SELECT key,label,created_at,last_used FROM agent_keys WHERE user_id=? ORDER BY created_at DESC").bind(uid).all();
      return Response.json({ client_keys: ck.results || [], agent_keys: ak.results || [] });
    }
    if (path === "/api/keys" && request.method === "POST") {
      const uid = await requireUser(request, env);
      if (!uid) return json401();
      const body = await request.json().catch(() => ({}));
      const kind = body.kind === "agent" ? "agent" : "client";
      const table = kind === "agent" ? "agent_keys" : "client_keys";
      const key = `${kind === "agent" ? "ak" : "ck"}_${randomId(32)}`;
      await env.DB.prepare(`INSERT INTO ${table} (key,user_id,label,created_at) VALUES (?,?,?,?)`).bind(key, uid, (body.label || "").slice(0, 64) || null, Date.now()).run();
      return Response.json({ key, kind });
    }
    if (path.startsWith("/api/keys/") && request.method === "DELETE") {
      const uid = await requireUser(request, env);
      if (!uid) return json401();
      const key = decodeURIComponent(path.slice("/api/keys/".length));
      await env.DB.prepare("DELETE FROM client_keys WHERE key=? AND user_id=?").bind(key, uid).run();
      await env.DB.prepare("DELETE FROM agent_keys WHERE key=? AND user_id=?").bind(key, uid).run();
      return Response.json({ ok: true });
    }

    // 面板页面
    if (path === "/panel") {
      return env.ASSETS.fetch(new Request(new URL("/panel.html", url), request));
    }

    return env.ASSETS.fetch(request);
  },
};

function json401() { return Response.json({ error: "unauthorized" }, { status: 401 }); }
function safeJSON(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

// 最小 MCP（Streamable HTTP）：list_devices + exec
async function handleMcp(rpc, uid, env) {
  const id = rpc.id ?? null;
  const reply = (result) => Response.json({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });
  const m = rpc.method;
  if (m === "initialize") {
    return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "axon", version: "0.1.0" } });
  }
  if (m === "notifications/initialized" || m === "notifications/cancelled") return new Response(null, { status: 202 });
  if (m === "ping") return reply({});
  if (m === "tools/list") {
    return reply({ tools: [
      { name: "list_devices", description: "列出当前账号下所有在线设备（name / type / 平台 / id）。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "exec", description: "在指定设备上执行命令并返回输出。daemon 设备执行 shell 命令，浏览器设备执行 JS。device 用设备的 name 或 id 指定。", inputSchema: { type: "object", properties: { device: { type: "string", description: "设备 name 或 id" }, command: { type: "string", description: "要执行的命令 / 代码" } }, required: ["device", "command"], additionalProperties: false } },
    ] });
  }
  if (m === "tools/call") {
    const name = rpc.params?.name;
    const args = rpc.params?.arguments || {};
    const hub = hubFor(env, uid);
    try {
      if (name === "list_devices") {
        const o = await hub.fetch(new Request(`https://x/hub/devices?uid=${uid}`)).then((r) => r.json());
        const lines = (o.devices || []).map((d) => `${d.name} (${d.type})  id=${d.deviceId}${d.meta?.hostname ? "  host=" + d.meta.hostname : ""}${d.meta?.platform ? "  " + d.meta.platform : ""}`);
        return reply({ content: [{ type: "text", text: lines.length ? lines.join("\n") : "(没有在线设备)" }] });
      }
      if (name === "exec") {
        const r = await hub.fetch(new Request(`https://x/hub/exec?uid=${uid}&device=${encodeURIComponent(args.device || "")}`, { method: "POST", body: args.command || "" }));
        const data = await r.json();
        const text = data.ok ? (data.result || "(无输出)") : `错误: ${data.error || "exec failed"}`;
        return reply({ content: [{ type: "text", text }], isError: !data.ok });
      }
      return fail(-32602, "unknown tool: " + name);
    } catch (e) {
      return fail(-32603, "internal error: " + e.message);
    }
  }
  return fail(-32601, "method not found: " + m);
}

// 把请求转发到某用户的 UserHub（改写 path + 注入 uid）
function hubFetch(env, uid, request, url, hubPath) {
  const hubUrl = new URL(url);
  hubUrl.pathname = hubPath;
  hubUrl.searchParams.set("uid", uid);
  return hubFor(env, uid).fetch(new Request(hubUrl, request));
}

function hubFor(env, uid) { return env.USERHUB.get(env.USERHUB.idFromName(uid)); }
function stubFor(env, id) { return env.DEVICE.get(env.DEVICE.idFromName(id)); }

// 查 key → user_id（client_keys 或 agent_keys），并异步更新 last_used
async function userIdForKey(env, table, key, ctx) {
  if (!env.DB || !key) return null;
  try {
    const row = await env.DB.prepare(`SELECT user_id FROM ${table} WHERE key=?`).bind(key).first();
    if (row && ctx) ctx.waitUntil(env.DB.prepare(`UPDATE ${table} SET last_used=? WHERE key=?`).bind(Date.now(), key).run().catch(() => {}));
    return row?.user_id || null;
  } catch { return null; }
}

async function userIdForAgentKey(env, request, ctx) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const key = m ? m[1].trim() : (new URL(request.url).searchParams.get("key") || "");
  return userIdForKey(env, "agent_keys", key, ctx);
}

// Legacy 设备 id：16–128 位 [A-Za-z0-9_-]
function getDeviceId(url) {
  const id = url.searchParams.get("id") || "";
  return /^[A-Za-z0-9_-]{16,128}$/.test(id) ? id : null;
}

// 服务端生成设备 id 用
function randomId(n) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

// Legacy AGENT_TOKEN 鉴权
function checkAuth(request, env) {
  if (!env.AGENT_TOKEN) return null;
  const auth = request.headers.get("Authorization") || "";
  if (auth === `Bearer ${env.AGENT_TOKEN}`) return null;
  return new Response("unauthorized", { status: 401 });
}
