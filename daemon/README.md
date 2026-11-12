# agent-axon

Axon daemon —— 让无公网 IP 的机器成为一台 [axon](https://github.com/slightc/axon) 设备：反连 Cloudflare Worker，把 AI agent 下发的命令在本机 shell 执行并回传（支持流式）。

## 用法

```bash
AXON_HOST=axon.hansc.workers.dev npx agent-axon
# 或全局安装
npm i -g agent-axon && AXON_HOST=axon.hansc.workers.dev agent-axon
```

启动后打印高熵设备 id（持久化到 `~/.axon/device-id`）。agent 用该 id `POST /exec` 下发命令，加 `?stream=1` 实时流式：

```bash
curl -N -X POST "https://axon.hansc.workers.dev/exec?id=<id>&stream=1" \
  -H "Authorization: Bearer <AGENT_TOKEN>" --data 'tail -f /path/to/serial.log'
```

环境变量：`AXON_HOST`、`AXON_DEVICE_ID`、`AXON_EXEC_TIMEOUT`、`AXON_STREAM_TIMEOUT`、`AXON_INSECURE`。

完整说明见主仓库 <https://github.com/slightc/axon>。

> ⚠️ daemon 会在本机 shell 直接执行收到的命令。只连你信任的 worker，并务必给 `/exec` 配强 `AGENT_TOKEN`。
