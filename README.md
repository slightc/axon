# Axon

AI 中枢把指令伸到远端末梢 —— 浏览器页面作为「设备」反连 Cloudflare，agent 通过 HTTP 下发任意 JS 代码在页面中执行，结果原路返回。全程走 CF 中继，验证内网穿透模型。

```
浏览器页面(设备) --wss--> Worker --> DeviceSession(DO) 持有长连接
Agent --POST /exec--> Worker --> DeviceSession(DO) --wss--> 设备执行 --> 结果返回
```

## 文件

| 文件 | 作用 |
|------|------|
| `src/index.js` | Worker 入口 + `DeviceSession` Durable Object |
| `public/index.html` | 设备页面（WS 连上、执行下发代码、实时显示） |
| `wrangler.jsonc` | Worker / DO / 静态资源 / 变量配置 |

## 本地跑

```bash
npm install
npm run dev          # 默认 http://localhost:8787
```

浏览器打开 `http://localhost:8787/?id=demo`，页面显示「在线」即连上。
本地 `AGENT_TOKEN` 若不想校验，dev 时可临时置空（见下）。

另开一个终端，模拟 agent 下发代码：

```bash
curl -X POST "http://localhost:8787/exec?id=demo" \
  -H "Authorization: Bearer change-me-demo-token" \
  --data 'document.body.style.background="#1a2a1a"; return document.title;'
# => {"ok":true,"result":"\"Axon · 设备页面\"","logs":[]}
```

页面背景会变色，执行记录实时出现在页面上。

## 部署到 Worker

```bash
npx wrangler login          # 首次，浏览器授权你的 CF 账号
npm run deploy              # = wrangler deploy
```

部署后拿到 `https://axon.<你的子域>.workers.dev`。
设备页面：`https://.../?id=<任意设备名>`；agent 用同样的 `id` POST `/exec`。

**生产 token** 改用 secret（别留明文 vars）：

```bash
wrangler secret put AGENT_TOKEN
# 然后删掉 wrangler.jsonc 里的 vars.AGENT_TOKEN
```

## HTTP 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/?id=<id>` | 设备页面 |
| WS   | `/connect?id=<id>` | 设备反向长连接（页面自动连） |
| POST | `/exec?id=<id>` | 下发代码，body 为 JS，同步返回执行结果（15s 超时） |
| GET  | `/status?id=<id>` | 查询设备是否在线 |

`/exec` 返回：`{ ok, result, logs }` 或 `{ ok:false, error }`。
下发的代码支持顶层 `await` 和 `return`，运行在页面全局上下文，可直接操作 DOM / `window`。

## 设备 id 与安全

每台设备用一个高熵、不可暴力猜测的 id（`dev_` + 32 字符 base62 ≈ 190 bit）。设备页面首次打开时自动生成，存入 `localStorage` 作为持久身份，并写回 URL —— 这条带 id 的 URL 就是该设备的 **capability link**：谁拿到它，才能连接并控制这台设备。

- 设备 id 由 `crypto.getRandomValues` 生成，无法枚举。
- Worker 对所有接口强制校验 id 格式（`[A-Za-z0-9_-]{16,128}`），弱 id / 缺失一律 `400`。
- `/exec` 另需 `AGENT_TOKEN`，构成「不可猜 id + token」双重门槛。
- 点击页面顶部的设备 id 可复制连接 URL，交给 agent 使用。

## 已知边界（demo 范围）

- DO 用普通 `accept()` 而非 Hibernation：pending 结果靠内存 Map 关联，设备在线期间 DO 保持活跃即可；生产大量设备应改 Hibernation + 存储层。
- 每个 deviceId 只保留最后一条设备连接（刷新会顶替旧的）。
- 未做 P2P、未做串口/硬件——这是第一步，只验证穿透与代码下发链路。

## 下一步

1. 把 `exec` 从「浏览器 JS」换成 daemon 的「shell / 子进程」，即可接真实远程电脑。
2. 加 WebRTC 信令（DO 转发 offer/answer/ICE），高频数据走 DataChannel，CF 中继兜底。
3. 封装成 MCP server，`list_devices` / `exec` / `serial_*` 等工具给 agent 用。
