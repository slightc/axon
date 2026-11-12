// MCP OAuth：axon 既当资源服务器又当授权服务器，让 claude.ai 这类连接器一键授权。
// 流程：发现(.well-known) → 动态注册(/register) → 授权(/authorize，复用 GitHub 登录) → 换码(/token)。
// 签发的 access_token 就是一个归属该用户的 agent key —— /mcp 现有鉴权逻辑直接认，用户可在 panel 撤销。

import { requireUser, setCookie } from "./auth.js";

const enc = new TextEncoder();
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256b64url(s) {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
function randomId(n) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}
function origin(env, request) {
  return env.PUBLIC_ORIGIN || new URL(request.url).origin;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function jsonCors(obj, status = 200) {
  return Response.json(obj, { status, headers: { ...CORS, "Cache-Control": "no-store" } });
}
function oauthErr(error, desc, status = 400) {
  return jsonCors(error_description(error, desc), status);
}
function error_description(error, desc) {
  return desc ? { error, error_description: desc } : { error };
}

// CORS 预检
export function oauthPreflight() {
  return new Response(null, { status: 204, headers: CORS });
}

// ---- 发现：资源元数据(RFC 9728) ----
// WWW-Authenticate 指向这里；path 后缀变体都返回同一份。
export function protectedResourceMetadata(env, request) {
  const o = origin(env, request);
  return jsonCors({
    resource: `${o}/mcp`,
    authorization_servers: [o],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  });
}

// ---- 发现：授权服务器元数据(RFC 8414) ----
export function authServerMetadata(env, request) {
  const o = origin(env, request);
  return jsonCors({
    issuer: o,
    authorization_endpoint: `${o}/authorize`,
    token_endpoint: `${o}/token`,
    registration_endpoint: `${o}/register`,
    scopes_supported: ["mcp"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

// ---- 动态客户端注册(RFC 7591) ----
export async function handleRegister(request, env) {
  if (request.method === "OPTIONS") return oauthPreflight();
  if (request.method !== "POST") return oauthErr("invalid_request", "POST required", 405);
  const body = await request.json().catch(() => null);
  if (!body) return oauthErr("invalid_client_metadata", "invalid JSON");
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string") : [];
  if (!redirectUris.length) return oauthErr("invalid_redirect_uri", "redirect_uris required");
  // 所有 redirect_uri 必须是 https 或 localhost
  for (const u of redirectUris) {
    let p; try { p = new URL(u); } catch { return oauthErr("invalid_redirect_uri", `bad uri: ${u}`); }
    const isLocal = p.hostname === "localhost" || p.hostname === "127.0.0.1";
    if (p.protocol !== "https:" && !isLocal) return oauthErr("invalid_redirect_uri", "redirect_uri must be https or localhost");
  }
  const clientId = "cid_" + randomId(24);
  await env.DB.prepare("INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at) VALUES (?,?,?,?)")
    .bind(clientId, JSON.stringify(redirectUris), (body.client_name || "").slice(0, 120) || null, Date.now()).run();
  return jsonCors({
    client_id: clientId,
    redirect_uris: redirectUris,
    client_name: body.client_name || undefined,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  }, 201);
}

async function loadClient(env, clientId) {
  if (!clientId) return null;
  const row = await env.DB.prepare("SELECT client_id, redirect_uris, client_name FROM oauth_clients WHERE client_id=?").bind(clientId).first();
  if (!row) return null;
  let uris = []; try { uris = JSON.parse(row.redirect_uris); } catch {}
  return { clientId: row.client_id, redirectUris: uris, clientName: row.client_name };
}

// ---- 授权端点 GET：校验参数 → 未登录先去 GitHub，登录了显示批准页 ----
export async function handleAuthorizeGet(request, env, url) {
  const q = url.searchParams;
  const clientId = q.get("client_id");
  const redirectUri = q.get("redirect_uri") || "";
  const responseType = q.get("response_type");
  const challenge = q.get("code_challenge");
  const challengeMethod = q.get("code_challenge_method");
  const state = q.get("state") || "";

  const client = await loadClient(env, clientId);
  if (!client) return htmlError("无效的 client_id —— 连接器未注册或已过期。");
  if (!client.redirectUris.includes(redirectUri)) return htmlError("redirect_uri 与注册值不匹配。");
  // 参数错误用 redirect 回报（redirect_uri 此时已校验可信）
  const bounce = (error, desc) => {
    const r = new URL(redirectUri);
    r.searchParams.set("error", error);
    if (desc) r.searchParams.set("error_description", desc);
    if (state) r.searchParams.set("state", state);
    return Response.redirect(r.toString(), 302);
  };
  if (responseType !== "code") return bounce("unsupported_response_type", "only code supported");
  if (!challenge || challengeMethod !== "S256") return bounce("invalid_request", "PKCE S256 required");

  // 未登录 → 存回跳地址，去 GitHub 登录
  const uid = await requireUser(request, env);
  if (!uid) {
    const headers = new Headers({ Location: "/auth/github" });
    headers.append("Set-Cookie", setCookie("axon_return_to", encodeURIComponent(url.pathname + url.search), 600));
    return new Response(null, { status: 302, headers });
  }
  // 已登录 → 批准页（参数塞进隐藏表单，POST /authorize）
  const u = await env.DB.prepare("SELECT name, email FROM users WHERE id=?").bind(uid).first().catch(() => null);
  return consentPage({
    clientName: client.clientName || "一个 MCP 连接器",
    userName: (u && (u.name || u.email)) || "你",
    params: { client_id: clientId, redirect_uri: redirectUri, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state, resource: q.get("resource") || "", scope: q.get("scope") || "mcp" },
  });
}

// ---- 授权端点 POST：用户点了批准/拒绝 ----
export async function handleAuthorizePost(request, env) {
  const uid = await requireUser(request, env);
  if (!uid) return htmlError("登录态已失效，请重新发起授权。");
  const form = new URLSearchParams(await request.text());
  const clientId = form.get("client_id");
  const redirectUri = form.get("redirect_uri") || "";
  const state = form.get("state") || "";
  const challenge = form.get("code_challenge") || "";
  const resource = form.get("resource") || "";
  const approve = form.get("approve") === "1";

  const client = await loadClient(env, clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) return htmlError("授权请求无效（client 或 redirect_uri）。");

  const r = new URL(redirectUri);
  if (state) r.searchParams.set("state", state);
  if (!approve) { r.searchParams.set("error", "access_denied"); return Response.redirect(r.toString(), 302); }
  if (!challenge) { r.searchParams.set("error", "invalid_request"); return Response.redirect(r.toString(), 302); }

  // 生成一次性 code + 待发 agent key（换码成功才落库）
  const code = "code_" + randomId(32);
  const agentKey = "ak_" + randomId(32);
  await env.DB.prepare(
    "INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, code_challenge, resource, agent_key, expires_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(code, clientId, uid, redirectUri, challenge, resource || null, agentKey, Date.now() + 10 * 60 * 1000).run();

  r.searchParams.set("code", code);
  return Response.redirect(r.toString(), 302);
}

// ---- 令牌端点：PKCE 校验 → 签发 access_token(= agent key) ----
export async function handleToken(request, env) {
  if (request.method === "OPTIONS") return oauthPreflight();
  if (request.method !== "POST") return oauthErr("invalid_request", "POST required", 405);
  const form = new URLSearchParams(await request.text());
  if (form.get("grant_type") !== "authorization_code") return oauthErr("unsupported_grant_type");
  const code = form.get("code") || "";
  const redirectUri = form.get("redirect_uri") || "";
  const clientId = form.get("client_id") || "";
  const verifier = form.get("code_verifier") || "";
  if (!code || !verifier) return oauthErr("invalid_request", "code and code_verifier required");

  const row = await env.DB.prepare("SELECT * FROM oauth_codes WHERE code=?").bind(code).first();
  if (!row) return oauthErr("invalid_grant", "unknown or used code");
  // 一次性：无论成功与否都删掉
  await env.DB.prepare("DELETE FROM oauth_codes WHERE code=?").bind(code).run();
  if (Date.now() > row.expires_at) return oauthErr("invalid_grant", "code expired");
  if (row.client_id !== clientId) return oauthErr("invalid_grant", "client_id mismatch");
  if (row.redirect_uri !== redirectUri) return oauthErr("invalid_grant", "redirect_uri mismatch");
  if ((await sha256b64url(verifier)) !== row.code_challenge) return oauthErr("invalid_grant", "PKCE verification failed");

  // 落库 agent key，作为长期 access_token 返回
  const client = await loadClient(env, clientId);
  const label = `oauth:${(client?.clientName || "connector").slice(0, 40)}`;
  await env.DB.prepare("INSERT INTO agent_keys (key,user_id,label,created_at) VALUES (?,?,?,?)")
    .bind(row.agent_key, row.user_id, label, Date.now()).run();

  return jsonCors({ access_token: row.agent_key, token_type: "Bearer", scope: "mcp" });
}

// ---- 批准页 / 错误页 ----
function page(title, body) {
  return new Response(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title} · Axon</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--blue:#58a6ff;--green:#3fb950;--red:#f85149;
--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--mono);font-size:14px;line-height:1.6;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;max-width:440px;width:100%;padding:28px;}
.logo{font-size:16px;font-weight:600;margin-bottom:4px;}
h1{font-size:18px;margin:14px 0 6px;}
p{color:var(--muted);margin:8px 0;}
b{color:var(--text);}
.scopes{border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin:16px 0;background:#010409;}
.scopes div{color:var(--text);margin:4px 0;font-size:13px;}
.scopes .em{color:var(--green);}
.row{display:flex;gap:10px;margin-top:20px;}
button{flex:1;font-family:var(--mono);font-size:14px;cursor:pointer;border-radius:8px;padding:10px;border:1px solid var(--border);}
.approve{background:var(--blue);color:#05070a;border-color:var(--blue);font-weight:600;}
.approve:hover{background:#79b8ff;}
.deny{background:transparent;color:var(--muted);}
.deny:hover{border-color:var(--red);color:var(--red);}
.err{color:var(--red);}
a{color:var(--blue);}
</style></head><body><div class="card">${body}</div></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}
function htmlError(msg) {
  return page("授权失败", `<div class="logo">🧠 Axon</div><h1 class="err">授权失败</h1><p>${msg}</p><p><a href="/panel">返回面板</a></p>`);
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function consentPage({ clientName, userName, params }) {
  const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return page("授权连接器", `
    <div class="logo">🧠 Axon</div>
    <h1>授权访问</h1>
    <p><b>${esc(clientName)}</b> 请求以 <b>${esc(userName)}</b> 的身份访问你的 axon 账号。</p>
    <div class="scopes">
      <div><span class="em">▸</span> 列出你名下所有在线设备</div>
      <div><span class="em">▸</span> 在这些设备上执行命令 / 代码</div>
    </div>
    <p>授权后会生成一个 agent key，你可随时在 <a href="/panel">面板</a> 撤销。</p>
    <form method="POST" action="/authorize">
      ${hidden}
      <div class="row">
        <button class="deny" type="submit" name="approve" value="0">取消</button>
        <button class="approve" type="submit" name="approve" value="1">授权</button>
      </div>
    </form>
  `);
}
