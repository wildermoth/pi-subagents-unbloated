// Scriptable fake Pi RPC child. Usage: bun test/fake-pi.ts --fake=<mode> [--fake-pid-file=<path>] [--delay=<ms>] ...
import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const mode = opt("fake") ?? "normal";
const delay = Number(opt("delay") ?? 300);
const pidFile = opt("fake-pid-file");
if (pidFile) writeFileSync(pidFile, String(process.pid));

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const assistant = (text: string, extra: object = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
  timestamp: 0,
  ...extra,
});
const respond = (id: string, command: string, data?: unknown) =>
  out({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });

async function finish(text: string, msg: object = {}) {
  const m = assistant(text, msg);
  out({ type: "agent_start" });
  out({ type: "message_end", message: m });
  out({ type: "agent_end", messages: [m], willRetry: false });
  out({ type: "agent_settled", aborted: false });
}

if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000); // keep alive past stdin close
}

async function onPrompt(id: string) {
  switch (mode) {
    case "exit-before-ack":
      process.stderr.write("boom: exiting before ack\n");
      process.exit(3);
    case "never-acks":
      return;
    case "rejected":
      return out({ id, type: "response", command: "prompt", success: false, error: "nope" });
    case "handled":
      return respond(id, "prompt", { disposition: "handled" });
  }
  respond(id, "prompt", { disposition: "started" });
  switch (mode) {
    case "descendant":
    case "descendant-hang": {
      const pid = opt("descendant-pid")!;
      const exited = opt("descendant-exit")!;
      const code = `const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(exited)}, "terminated"); process.exit(0); }); fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid)); setInterval(() => {}, 1000);`;
      spawn(process.execPath, ["-e", code], { stdio: "ignore" }).unref();
      while (!existsSync(pid)) await sleep(1);
      if (mode === "descendant") await finish("spawned descendant");
      return;
    }
    case "exit-after-ack":
      process.stderr.write("crash after ack\n");
      process.exit(4);
    case "partial-hang": // said something, then never settles
      out({ type: "agent_start" });
      out({ type: "message_end", message: assistant("so far so good") });
      return;
    case "length":
      return finish("cut off mid sen", { stopReason: "length" });
    case "never-settles":
    case "stubborn":
    case "steerable":
      return;
    case "delayed":
      await sleep(delay);
      return finish("delayed answer");
    case "malformed":
      process.stdout.write("{not json\n");
      return;
    case "overflow":
      process.stdout.write("x".repeat(17 * 1024 * 1024)); // no newline
      return;
    case "stderr-flood": {
      const chunk = "e".repeat(65536);
      for (let i = 0; i < 80; i++) process.stderr.write(chunk);
      return finish("flooded");
    }
    case "provider-error":
      return finish("", { stopReason: "error", errorMessage: "529 overloaded", content: [] });
    case "aborted-run":
      return finish("", { stopReason: "aborted", content: [] });
    case "settle-no-message":
      return out({ type: "agent_settled", aborted: false });
    case "ui": {
      out({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow?", message: "really" });
      out({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "fyi" });
      return; // finishes when the response arrives
    }
    case "huge":
      return finish("h".repeat(100_000));
    case "huge-unicode":
      return finish("é".repeat(50_000));
    case "unicode":
      return finish("line1 line2 line3 \u{1F600}");
    case "split": {
      const lines = [
        { type: "message_end", message: assistant("split \u{1F600} answer   ok") },
        { type: "agent_settled", aborted: false },
      ].map((o) => Buffer.from(JSON.stringify(o) + "\n"));
      for (const b of lines) {
        for (let i = 0; i < b.length; i += 3) {
          process.stdout.write(b.subarray(i, i + 3));
          await sleep(1);
        }
      }
      return;
    }
    case "echo-args":
      return finish(JSON.stringify({ args: argv, env: process.env.PI_SUBAGENT_CHILD, cwd: process.cwd() }));
    default:
      return finish("hello");
  }
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  if (mode !== "stubborn") process.exit(0);
});

async function handle(cmd: any) {
  if (cmd.type === "extension_ui_response") {
    if (cmd.id === "ui-1") await finish(`ui:${cmd.cancelled ? "cancelled" : "answered"}`);
    return;
  }
  if (cmd.type === "prompt") return onPrompt(cmd.id);
  if (cmd.type === "steer") {
    respond(cmd.id, "steer", { disposition: "queued" });
    if (mode === "steerable") await finish(`steered:${cmd.message}`);
    return;
  }
  if (cmd.type === "abort") return respond(cmd.id, "abort"); // like stubborn Pi: ack but keep running
  if (cmd.type === "get_state") return respond(cmd.id, "get_state", { isStreaming: false });
  out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "unknown" });
}
