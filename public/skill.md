---
name: axon
description: 通过 axon 平台连接并操作远程设备（无公网 IP 的电脑 / 浏览器 / 嵌入式硬件）。当需要在某台远程机器上跑 shell 命令、读串口 log、烧录固件、或操作浏览器页面时使用。
---

# Axon

用 axon 在无公网 IP 的远程设备上执行命令。设备（daemon / 浏览器）用 client key 连到 axon worker，agent 用 agent key 或 MCP 操作它们。

Base URL 默认 `https://axon.hansc.workers.dev`（用户可自建，用他们给的域名）。鉴权 key 从环境变量读：`AXON_AGENT_KEY`、`AXON_BASE`（可选）。

## 接入方式

### 优先 MCP（若会话里已配置 axon MCP server）
直接调工具：
- `list_devices()` → 在线设备（name / type / 平台 / id）
- `exec(device, command)` → 在该设备执行；`device` 用 name 或 id

### 否则用 HTTP（agent key）
```bash
BASE="${AXON_BASE:-https://axon.hansc.workers.dev}"
# 列设备
curl -s "$BASE/agent/devices" -H "Authorization: Bearer $AXON_AGENT_KEY"
# 执行（device = name 或 id）
curl -s -X POST "$BASE/agent/exec?device=<name|id>" -H "Authorization: Bearer $AXON_AGENT_KEY" --data '命令'
# 流式（tail -f / 烧录进度 / 长命令）
curl -sN -X POST "$BASE/agent/exec?device=<name|id>&stream=1" -H "Authorization: Bearer $AXON_AGENT_KEY" --data '命令'
```
流式返回 NDJSON：每行 `{"t":"out"|"err","d":"..."}`，结束 `{"t":"end","ok":...,"exitCode":...}`。

## 常用任务

**先列设备**确认目标 name / 平台，再操作。

**在远程电脑跑命令**
```
exec device=<name> command="uname -a && df -h"
```

**读串口 log**（daemon 设备 + 接了 USB 串口）
```
# 先探测串口
exec device=<name> command="ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null"
# 流式读（115200）
/agent/exec?device=<name>&stream=1   command="stty -F /dev/ttyUSB0 115200 raw -echo && cat /dev/ttyUSB0"
```

**烧录固件**（工具链已装）
```
# ESP32
exec command="esptool.py --port /dev/ttyUSB0 --baud 460800 write_flash 0x0 firmware.bin"
# STLink / JTAG
exec command="openocd -f interface/stlink.cfg -f target/<chip>.cfg -c 'program firmware.elf verify reset exit'"
```

**操作浏览器页面**（浏览器设备，command 是 JS）
```
exec device=<name> command="return document.title"
exec device=<name> command="document.querySelector('#kw').value='x'; return 'filled'"
```

## 注意

- `device` 用 name（人类可读，面板可改）或高熵 id 指定。
- legacy 设备（没配 client key、用 device id 直连的）也能访问：`exec` 的 `device` 直接填它的 device id，账号设备里找不到会自动回退直连该 id。
- daemon 设备的 command 是 **shell**；浏览器设备的 command 是 **JS**（用 `return` 返回值）。
- 持续输出（`tail -f`、`logread -f`、烧录进度）必须用 `stream=1`，否则会超时。
- 串口 / 烧录 / openocd 都是**组合 shell 命令**——daemon 不内置这些，靠本 skill 拼命令。
- 一次非流式 exec 上限约 12s；更长的用 stream。
