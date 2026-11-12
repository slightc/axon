/**
 * 远程 Agent 控制平台 — 最小 Demo
 *
 * 链路：
 *   浏览器页面(设备) --wss--> Worker --> DeviceSession(DO) 持有长连接
 *   Agent --POST /exec--> Worker --> DeviceSession(DO) --wss--> 设备执行 --> 结果原路返回
 *
 * 这一版只做「浏览器页面作为设备 + agent 下发任意 JS 代码执行」，
 * 全程走 CF 中继（未做 P2P），验证穿透模型是否成立。
 */

// 一台设备 = 一个 DO 实例，key = deviceId。
// DO 持有该设备的 WebSocket，并在 agent 的 HTTP 请求与设备之间做请求/响应关联。
export class DeviceSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.deviceSocket = null;        // 当前设备的 WS（同一时刻只保留最后一个）
    this.pending = new Map();        // reqId -> { resolve, timer }，等待设备回传结果
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

  // 设备页面连上来，升级为 WebSocket 并持有
  handleConnect(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // 顶替旧连接（页面刷新/重连时）
    if (this.deviceSocket) {
      try { this.deviceSocket.close(1000, "replaced"); } catch {}
    }
    this.deviceSocket = server;
    this.meta.connectedAt = Date.now();
    this.meta.ua = request.headers.get("user-agent");

    server.addEventListener("message", (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (msg.type === "result") {
        // 设备执行完回传，按 reqId 唤醒对应的 agent 请求
        const p = this.pending.get(msg.reqId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.reqId);
          p.resolve(msg);
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

  // agent 下发代码，等设备回传结果（15s 超时）
  async handleExec(request) {
    if (!this.deviceSocket) {
      return Response.json({ ok: false, error: "device offline" }, { status: 503 });
    }
    const code = await request.text();
    if (!code.trim()) {
      return Response.json({ ok: false, error: "empty code" }, { status: 400 });
    }

    const reqId = crypto.randomUUID();
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve({ ok: false, error: "timeout (15s)" });
      }, 15000);
      this.pending.set(reqId, { resolve, timer });
      try {
        this.deviceSocket.send(JSON.stringify({ type: "exec", reqId, code }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        resolve({ ok: false, error: "send failed: " + e.message });
      }
    });
    return Response.json(result);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 设备 WS 入口：/connect?id=<deviceId>
    if (path === "/connect") {
      const id = url.searchParams.get("id") || "demo";
      return stubFor(env, id).fetch(request);
    }

    // agent 下发代码：POST /exec?id=<deviceId>，body = 要执行的 JS
    if (path === "/exec" && request.method === "POST") {
      const unauth = checkAuth(request, env);
      if (unauth) return unauth;
      const id = url.searchParams.get("id") || "demo";
      return stubFor(env, id).fetch(request);
    }

    // 设备在线状态：GET /status?id=<deviceId>
    if (path === "/status") {
      const id = url.searchParams.get("id") || "demo";
      return stubFor(env, id).fetch(request);
    }

    // 其余交给静态资源（public/index.html 即设备页面）
    return env.ASSETS.fetch(request);
  },
};

function stubFor(env, id) {
  return env.DEVICE.get(env.DEVICE.idFromName(id));
}

// 简易 bearer 鉴权；AGENT_TOKEN 为空则放行（仅本地 dev 用）
function checkAuth(request, env) {
  if (!env.AGENT_TOKEN) return null;
  const auth = request.headers.get("Authorization") || "";
  if (auth === `Bearer ${env.AGENT_TOKEN}`) return null;
  return new Response("unauthorized", { status: 401 });
}
