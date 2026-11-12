// 认证：JWT(HS256) + GitHub OAuth + cookie。provider 可扩展（后续加 email/google）。

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signJWT(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

export async function verifyJWT(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let ok;
  try { ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(s), enc.encode(`${h}.${p}`)); } catch { return null; }
  if (!ok) return null;
  try {
    const payload = JSON.parse(dec.decode(b64urlDecode(p)));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ---- cookie ----
export function setCookie(name, value, maxAge) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
export function getCookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

// 返回当前登录用户 id（校验 session JWT），未登录返回 null
export async function requireUser(request, env) {
  return (await verifyJWT(getCookie(request, "axon_session"), env.JWT_SECRET))?.uid || null;
}

// ---- GitHub OAuth ----
function origin(env, request) {
  return env.PUBLIC_ORIGIN || new URL(request.url).origin;
}
export function githubAuthUrl(env, request, state) {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", env.GITHUB_CLIENT_ID || "");
  u.searchParams.set("redirect_uri", `${origin(env, request)}/auth/github/callback`);
  u.searchParams.set("scope", "read:user user:email");
  u.searchParams.set("state", state);
  return u.toString();
}
export async function githubExchange(env, request, code) {
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
      code, redirect_uri: `${origin(env, request)}/auth/github/callback`,
    }),
  });
  return (await r.json().catch(() => ({}))).access_token || null;
}
export async function githubUser(token) {
  const r = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "axon", Accept: "application/vnd.github+json" },
  });
  return r.ok ? r.json() : null;
}

// upsert 一个 github 用户，返回 user_id
export async function upsertGithubUser(env, gh, randomId) {
  const pid = String(gh.id);
  const existing = await env.DB.prepare("SELECT id FROM users WHERE provider='github' AND provider_id=?").bind(pid).first();
  if (existing) {
    await env.DB.prepare("UPDATE users SET name=?, email=?, avatar=? WHERE id=?")
      .bind(gh.name || gh.login, gh.email || null, gh.avatar_url || null, existing.id).run();
    return existing.id;
  }
  const uid = "u_" + randomId(16);
  await env.DB.prepare("INSERT INTO users (id,provider,provider_id,email,name,avatar,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(uid, "github", pid, gh.email || null, gh.name || gh.login, gh.avatar_url || null, Date.now()).run();
  return uid;
}
