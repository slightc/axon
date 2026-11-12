-- Axon 数据库 schema（Cloudflare D1 / SQLite）
-- 用户体系 + client/agent key + 设备注册表

-- 用户
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,          -- uuid
  provider    TEXT NOT NULL,             -- 'github' / 'manual' / 'email' / 'google' ...
  provider_id TEXT,                      -- 第三方登录的用户 id
  email       TEXT,
  name        TEXT,
  avatar      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id);

-- client key：设备（daemon/浏览器/油猴）用它连接
CREATE TABLE IF NOT EXISTS client_keys (
  key        TEXT PRIMARY KEY,           -- 高熵
  user_id    TEXT NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL,
  last_used  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_client_keys_user ON client_keys(user_id);

-- agent key：agent 用它授权（与 MCP 鉴权并列）
CREATE TABLE IF NOT EXISTS agent_keys (
  key        TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL,
  last_used  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_keys_user ON agent_keys(user_id);

-- 设备注册表
--   name: 可选，连接时不传则服务端按 type 生成（如 daemon-a1b2）；同一用户下重名时服务端改名；面板可改
--   type: 可选，client 自报（daemon/browser/userscript）；面板可改
CREATE TABLE IF NOT EXISTS devices (
  id         TEXT PRIMARY KEY,           -- 设备高熵 id（client 持久化）
  user_id    TEXT NOT NULL,
  name       TEXT,
  type       TEXT,
  client_key TEXT,                       -- 通过哪个 client key 连入
  meta       TEXT,                       -- JSON：hostname/platform/arch 等
  first_seen INTEGER,
  last_seen  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_name ON devices(user_id, name);

-- ===== MCP OAuth（让 claude.ai 等连接器一键授权）=====
-- 动态注册（RFC 7591）的 OAuth client：claude.ai 连接时自动注册，拿到 client_id
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,      -- JSON array，授权时精确匹配
  client_name   TEXT,
  created_at    INTEGER NOT NULL
);

-- 一次性授权码：用户在 /authorize 批准后生成，短期有效，/token 用 PKCE 校验后换 access_token
CREATE TABLE IF NOT EXISTS oauth_codes (
  code           TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,     -- PKCE S256 challenge
  resource       TEXT,              -- RFC 8707 目标资源
  agent_key      TEXT NOT NULL,     -- 待发的 access_token（换取成功才写入 agent_keys）
  expires_at     INTEGER NOT NULL
);
