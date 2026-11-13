# @slightc/axon

Axon daemon —— 让无公网 IP 的机器成为一台 [axon](https://github.com/slightc/axon) 设备：反连 Cloudflare Worker，把 AI agent 下发的命令在本机 shell 执行并回传（支持流式）。

## 用法

两种模式，二选一：

```bash
# 账号模式（推荐）—— 设备归属你的账号、面板可见、可按名字指定。
# 先在 https://axon.hansc.workers.dev/panel 登录生成 client key：
AXON_CLIENT_KEY=<client key> AXON_NAME=my-pc npx @slightc/axon

# legacy 模式 —— 不用登录，直接跑，启动后打印高熵 device id：
npx @slightc/axon
```

agent 用设备 name 或 device id 下发命令，加 `?stream=1` 实时流式（`tail -f`、烧录进度等）。自建部署加 `AXON_HOST=<你的域名>`（默认 `axon.hansc.workers.dev`）。`bin` 提供两个等价入口：`axon-cli`、`axon-daemon`。

环境变量：`AXON_HOST`、`AXON_CLIENT_KEY`、`AXON_NAME`、`AXON_DEVICE_ID`、`AXON_EXEC_TIMEOUT`、`AXON_STREAM_TIMEOUT`、`AXON_INSECURE`。

完整说明见主仓库 <https://github.com/slightc/axon>。

> ⚠️ daemon 会在本机 shell 直接执行收到的命令。只连你信任的 worker，别用高权限账号跑。legacy 模式下，worker 的 `AGENT_TOKEN` 为空则谁拿到 device id 谁能执行。
