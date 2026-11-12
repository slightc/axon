#!/usr/bin/env node
/**
 * Axon daemon —— 让无公网 IP 的真实电脑成为一台 axon 设备。
 *
 * 反连 worker 的 /connect（与浏览器设备同一套 WS 协议），收到 {type:'exec', code}
 * 时把 code 当作本机 shell 命令执行，收集 stdout/stderr 回传。Worker / agent 接口
 * 无需任何改动 —— 浏览器设备把 code 当 JS 跑，daemon 把 code 当命令跑。
 *
 * 配置（环境变量）：
 *   AXON_HOST          worker 域名，默认 axon.hansc.workers.dev
 *   AXON_INSECURE      置任意值则用 ws:// 而非 wss://（本地调试）
 *   AXON_DEVICE_ID     指定设备 id（默认自动生成并持久化到 ~/.axon/device-id）
 *   AXON_EXEC_TIMEOUT  单命令超时 ms，默认 12000（需 < worker 的 15s）
 */
import WebSocket from "ws";
import { spawn } from "child_process";
import crypto from "crypto";
import os from "os";
import fs from "fs";
import path from "path";

const HOST = process.env.AXON_HOST || "axon.hansc.workers.dev";
const PROTO = process.env.AXON_INSECURE ? "ws" : "wss";
const EXEC_TIMEOUT = Number(process.env.AXON_EXEC_TIMEOUT || 12000);
const STREAM_TIMEOUT = Number(process.env.AXON_STREAM_TIMEOUT || 600000); // 流式命令上限 10min
const running = new Map(); // reqId -> 流式子进程（供 cancel 终止）

// 高熵、不可暴力猜测的设备 id（dev_ + 32 字符 base62），持久化到 ~/.axon/device-id
function loadOrCreateId() {
  const dir = path.join(os.homedir(), ".axon");
  const file = path.join(dir, "device-id");
  try { const v = fs.readFileSync(file, "utf8").trim(); if (v) return v; } catch {}
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const buf = crypto.randomBytes(32);
  const id = "dev_" + Array.from(buf, (b) => chars[b % chars.length]).join("");
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, id); } catch {}
  return id;
}
const ID = process.env.AXON_DEVICE_ID || loadOrCreateId();
const wsUrl = `${PROTO}://${HOST}/connect?id=${encodeURIComponent(ID)}`;

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), ...a);

// 在本机 shell 执行命令，收集输出（带超时、输出截断）
function runCommand(cmd) {
  return new Promise((resolve) => {
    log("▸", cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd);
    let out = "", err = "", done = false;
    const child = spawn(cmd, { shell: true });
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ ok: false, error: `timeout (${EXEC_TIMEOUT}ms)`, result: out, logs: err ? [err] : [] });
    }, EXEC_TIMEOUT);
    child.stdout.on("data", (d) => { out += d; if (out.length > 512 * 1024) out = out.slice(-512 * 1024); });
    child.stderr.on("data", (d) => { err += d; if (err.length > 128 * 1024) err = err.slice(-128 * 1024); });
    child.on("close", (code) => finish({ ok: code === 0, result: out, exitCode: code, logs: err ? err.split("\n").filter(Boolean).slice(-50) : [] }));
    child.on("error", (e) => finish({ ok: false, error: e.message }));
  });
}

// 流式执行：stdout/stderr 每来一块就推 {type:'stream'}，进程结束发 {type:'result'}
function runCommandStream(reqId, cmd) {
  log("▸ (stream)", cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd);
  const child = spawn(cmd, { shell: true });
  running.set(reqId, child);
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  child.stdout.on("data", (d) => send({ type: "stream", reqId, stream: "out", data: d.toString() }));
  child.stderr.on("data", (d) => send({ type: "stream", reqId, stream: "err", data: d.toString() }));
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, STREAM_TIMEOUT);
  child.on("close", (code) => { clearTimeout(timer); running.delete(reqId); send({ type: "result", reqId, ok: code === 0, exitCode: code }); });
  child.on("error", (e) => { clearTimeout(timer); running.delete(reqId); send({ type: "result", reqId, ok: false, error: e.message }); });
}

let ws, pingTimer, reconnectTimer, manualExit = false;
function connect() {
  log("connecting", wsUrl);
  ws = new WebSocket(wsUrl);
  ws.on("open", () => {
    log("✓ online");
    ws.send(JSON.stringify({ type: "hello", info: { kind: "daemon", hostname: os.hostname(), platform: os.platform(), arch: os.arch(), cwd: process.cwd(), node: process.version } }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" })); }, 30000);
  });
  ws.on("message", async (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "exec") {
      if (msg.stream) {
        runCommandStream(msg.reqId, msg.code);
      } else {
        const res = await runCommand(msg.code);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "result", reqId: msg.reqId, ...res }));
      }
    } else if (msg.type === "cancel") {
      const child = running.get(msg.reqId);
      if (child) { try { child.kill("SIGKILL"); } catch {} running.delete(msg.reqId); log("✗ cancelled", msg.reqId); }
    }
  });
  ws.on("close", () => {
    clearInterval(pingTimer);
    if (manualExit) return;
    log("disconnected, reconnecting in 3s");
    reconnectTimer = setTimeout(connect, 3000);
  });
  ws.on("error", (e) => { log("ws error:", e.message); try { ws.close(); } catch {} });
}

process.on("SIGINT", () => { manualExit = true; clearTimeout(reconnectTimer); log("bye"); try { ws && ws.close(); } catch {} process.exit(0); });

console.log(`\n  🧠 Axon daemon`);
console.log(`  device id : ${ID}`);
console.log(`  worker    : ${PROTO}://${HOST}`);
console.log(`  ⚠️  收到的命令会在本机 shell 直接执行 —— 只连你信任的 worker，并务必给 /exec 配 AGENT_TOKEN\n`);
connect();
