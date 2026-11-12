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
