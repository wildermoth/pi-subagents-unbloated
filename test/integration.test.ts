// Real Pi smoke test: startup, get_state, shutdown. Never sends a prompt (no model calls).
// Run with PI_INTEGRATION=1 bun test test/integration.test.ts
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { RpcConnection } from "../src/protocol.ts";
import { resolvePiCommand } from "../src/runner.ts";

test.skipIf(process.env.PI_INTEGRATION !== "1")("real pi: get_state then orderly shutdown", async () => {
  const cmd = resolvePiCommand();
  const child = spawn(cmd.command, [...cmd.args, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-themes", "--no-mcp", "--offline", "--no-session", "--no-approve"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const errors: Error[] = [];
  const c = new RpcConnection(child, { onEvent() {}, onProtocolError: (e) => errors.push(e) });
  const r = await c.send({ type: "get_state" }, 15_000);
  expect(r.success).toBe(true);
  expect(typeof r.data.isStreaming).toBe("boolean");
  c.closeInput();
  const exit = await Promise.race([c.exited, Bun.sleep(10_000).then(() => "hung" as const)]);
  if (exit === "hung") child.kill("SIGKILL");
  expect(exit).not.toBe("hung");
  expect(errors).toEqual([]);
}, 30_000);
