# Axon

AI 中枢把指令伸到远端末梢 —— 浏览器页面作为「设备」反连 Cloudflare，agent 通过 HTTP 下发任意 JS 代码在页面中执行，结果原路返回。全程走 CF 中继，验证内网穿透模型。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/slightc/axon)

> 点上方按钮会把本仓库 fork 到你的 GitHub，并自动创建 Worker、provision Durable Object、配好 Workers Builds，之后每次 push 自动部署。部署后记得把 `AGENT_TOKEN` 改成 Secret（见下方「设备 id 与安全」）。

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

## 浏览器油猴脚本（控制任意页面）

`userscript/axon.user.js` 是一个 Tampermonkey / Greasemonkey 用户脚本。装上后，它在你浏览的**任意网页**右下角浮一个小控件，点「开始连接」即把当前页面注册成一台 axon 设备，agent 便能下发代码操控这个真实页面；可随时断开、可收起。连接状态会跨页面保持 —— 导航到新页面时自动续连，因此适合「搜索 → 结果页 → 点进详情」这类多步任务。

安装：

1. 浏览器装 Tampermonkey（或兼容的用户脚本管理器）
2. 新建脚本，粘贴 `userscript/axon.user.js` 的全部内容
3. 把文件顶部的 `AXON_HOST` 改成你自己的 worker 域名（默认 `axon.hansc.workers.dev`）
4. 保存，刷新任意页面，右下角出现「🧠 Axon」控件

控件里的设备 id 同样是高熵不可猜、按站点持久化，点一下即可复制交给 agent。脚本用 `@grant none` 运行在页面上下文，因此下发的代码能直接操作该页面的真实 DOM —— 个别启用了严格 CSP（`connect-src` 或禁 `unsafe-eval`）的站点可能连不上或无法执行，属预期限制。

## 真实电脑 daemon（shell / 命令）

`daemon/axon-daemon.mjs` 让无公网 IP 的真实电脑成为一台 axon 设备：反连 worker，把收到的 `code` 当作本机 shell 命令执行并回传 stdout / stderr / 退出码。Worker 与 agent 接口和浏览器设备完全一致 —— 浏览器把 `code` 当 JS 跑，daemon 把 `code` 当命令跑。

运行：

```bash
cd daemon && npm install
AXON_HOST=axon.hansc.workers.dev node axon-daemon.mjs
# 发布到 npm 后可直接：npm i -g @slightc/axon && AXON_HOST=axon.hansc.workers.dev axon-cli
```

启动后打印设备 id（高熵，持久化到 `~/.axon/device-id`）。agent 用这个 id POST `/exec`，body 即命令：

```bash
curl -X POST "https://axon.hansc.workers.dev/exec?id=<id>" \
  -H "Authorization: Bearer <AGENT_TOKEN>" --data 'uname -a'
# => { "ok": true, "result": "<stdout>", "exitCode": 0, "logs": ["<stderr>"] }
```

配置项：`AXON_HOST`、`AXON_DEVICE_ID`、`AXON_EXEC_TIMEOUT`（非流式单命令上限，默认 12000ms，需 < worker 的 15s）、`AXON_STREAM_TIMEOUT`（流式上限，默认 600000ms）、`AXON_INSECURE`（本地用 `ws://`）。

### 流式输出

加 `?stream=1`，响应变成一条 NDJSON 流，设备产出的每块 stdout/stderr 实时到达 —— 适合 `tail -f`、串口 log、烧录进度、长命令：

```bash
curl -N -X POST "https://axon.hansc.workers.dev/exec?id=<id>&stream=1" \
  -H "Authorization: Bearer <AGENT_TOKEN>" --data 'tail -f /path/to/serial.log'
```

每行一个 JSON：`{"t":"out"|"err","d":"<块>"}`，结束为 `{"t":"end","ok":...,"exitCode":...}`。agent 关闭连接（`curl` Ctrl-C）会通知设备终止该命令；流式上限 10min。不带 `stream=1` 则是一次性执行。

> ⚠️ **安全**：daemon 会在本机 shell 直接执行收到的任意命令。只连你信任的 worker，务必给 `/exec` 配强 `AGENT_TOKEN`，别用高权限账号跑它。每条命令都会打印在 daemon 控制台，便于审计。
>
> 串口读取、烧录、openocd 这类**专用功能不在 daemon 里硬编码**，而是由 agent 侧的 skill 组合 shell 命令（配合 `?stream=1`）实现 —— daemon 保持通用，专用逻辑留在可迭代的 skill 层。

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
