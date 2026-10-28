// Real runner + real Pi against a local fake OpenAI-compatible server (no paid model).
// Run with PI_INTEGRATION=1 bun test test/integration-model.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgentDir, sse, startFakeServer, chunk, textReply, usage } from "./helpers/fake-provider.ts";
import { RpcConnection } from "../src/protocol.ts";
import { buildArgs, createRunner, resolvePiCommand } from "../src/runner.ts";
import type { RunSpec } from "../src/types.ts";

const enabled = process.env.PI_INTEGRATION === "1";
const T = (name: string, fn: () => Promise<void>) => test.skipIf(!enabled)(name, fn, 60_000);

type Reply = "text" | "tool-then-text" | "hang" | "http500";
let script: Reply = "text";
const bodies: any[] = [];
let server: ReturnType<typeof Bun.serve>;
let agentDir: string;
let work: string;
const savedEnv = { dir: process.env.PI_CODING_AGENT_DIR, tel: process.env.PI_TELEMETRY };

function handle(body: any): Response | Promise<Response> {
  const hasToolResult = body.messages?.some((m: any) => m.role === "tool");
  switch (script) {
    case "text": return textReply("fake answer");
    case "tool-then-text":
      if (hasToolResult) return textReply("file says: " + body.messages.findLast((m: any) => m.role === "tool").content);
      return sse([chunk({ role: "assistant", content: "" }),
        chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(work, "hello.txt") }) } }] }),
        chunk({}, "tool_calls", { usage })]);
    case "http500": return new Response(JSON.stringify({ error: { message: "boom from fake", type: "server_error" } }), { status: 500, headers: { "content-type": "application/json" } });
    case "hang": return new Promise<Response>(() => {});
  }
}

beforeAll(() => {
  if (!enabled) return;
  work = mkdtempSync(join(tmpdir(), "pi-int-work-"));
  writeFileSync(join(work, "hello.txt"), "SECRET-CONTENT-42");
  server = startFakeServer(handle, bodies);
  agentDir = makeAgentDir(server.port!);
  // Marker extension: proves whether extensions load.
  mkdirSync(join(agentDir, "extensions"));
  writeFileSync(join(agentDir, "extensions", "marker.ts"),
    `import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(join(agentDir, "marker"))}, "loaded"); }\n`);
  process.env.PI_CODING_AGENT_DIR = agentDir; // the runner spawns children with the parent's env
  process.env.PI_TELEMETRY = "0";
});

afterAll(() => {
  void server?.stop(true);
  for (const [k, v] of [["PI_CODING_AGENT_DIR", savedEnv.dir], ["PI_TELEMETRY", savedEnv.tel]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const spec = (o: Partial<RunSpec> = {}): RunSpec => ({
  cwd: work, task: "say something", systemPrompt: "You are a test agent.", model: "fake/fake-model",
  trusted: false, timeoutMs: 40_000, launchTimeoutMs: 20_000, ...o,
});
const runner = () => createRunner({ graceMs: 1500 });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Spawn real Pi exactly as the runner does, recording every response and event. */
function rawPi(extraArgs: string[] = [], dropArgs: string[] = []) {
  const cmd = resolvePiCommand();
  const args = buildArgs(spec()).filter((a) => !dropArgs.includes(a));
  const child = spawn(cmd.command, [...cmd.args, ...args, ...extraArgs], { cwd: work, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const events: any[] = [];
  const waiters: (() => void)[] = [];
  const conn = new RpcConnection(child, { onEvent: (e) => { events.push(e); waiters.splice(0).forEach((w) => w()); }, onProtocolError: () => {} });
  const waitFor = async (type: string, ms = 30_000) => {
    const t0 = Date.now();
    while (!events.some((e) => e.type === type)) {
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${type}; saw ${events.map((e) => e.type).join(",")}`);
      await Promise.race([new Promise<void>((r) => waiters.push(r)), Bun.sleep(200)]);
    }
  };
  const stop = async () => { conn.closeInput(); await Promise.race([conn.exited, Bun.sleep(5000)]); if (child.pid && alive(child.pid)) child.kill("SIGKILL"); };
  return { conn, events, waitFor, stop, child };
}

describe("real pi + fake provider", () => {
  T("(a,b) ack is 'started', then agent_end, then agent_settled; event shapes", async () => {
    script = "text";
    const p = rawPi();
    try {
      const ack = await p.conn.send({ type: "prompt", message: "hi" }, 20_000);
      expect(ack.success).toBe(true);
      expect(ack.data!.disposition).toBe("started");
      await p.waitFor("agent_settled");
      const types = p.events.map((e) => e.type);
      expect(types.indexOf("agent_end")).toBeGreaterThan(-1);
      expect(types.indexOf("agent_end")).toBeLessThan(types.indexOf("agent_settled"));
      const assistantEnd = p.events.filter((e) => e.type === "message_end" && e.message?.role === "assistant");
      expect(assistantEnd.length).toBe(1);
      const m = assistantEnd[0].message;
      expect(m.stopReason).toBe("stop");
      expect(m.content.find((b: any) => b.type === "text").text).toBe("fake answer");
      const end = p.events.find((e) => e.type === "agent_end");
      expect(Array.isArray(end.messages)).toBe(true);
      expect(end.messages.findLast((x: any) => x.role === "assistant").stopReason).toBe("stop");
    } finally { await p.stop(); }
  });

  T("(a,b) provider 500: assistant message has stopReason error + errorMessage", async () => {
    script = "http500";
    const p = rawPi();
    try {
      await p.conn.send({ type: "prompt", message: "hi" }, 20_000);
      await p.waitFor("agent_settled", 50_000);
      const m = p.events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").at(-1).message;
      expect(m.stopReason).toBe("error");
      expect(String(m.errorMessage)).toContain("500");
    } finally { await p.stop(); }
  });

  T("(c) runner extracts final text", async () => {
    script = "text";
    const r = await runner().start(spec()).done;
    expect(r).toEqual({ status: "completed", text: "fake answer", truncated: false });
  });

  T("(c) tool call to read then final text; last assistant text wins", async () => {
    script = "tool-then-text";
    bodies.length = 0;
    const r = await runner().start(spec({ tools: ["read"] })).done;
    expect(r.status).toBe("completed");
    expect(r.text).toBe("file says: SECRET-CONTENT-42");
    expect(bodies.length).toBe(2);
  });

  T("(d) provider HTTP 500 gives failed/provider", async () => {
    script = "http500";
    const r = await runner().start(spec()).done;
    expect(r.status).toBe("failed");
    expect(r.failure?.kind).toBe("provider");
    expect(r.failure?.message).toContain("500");
  });

  T("(e) cancel during hang yields cancelled and no leaked pid", async () => {
    script = "hang";
    bodies.length = 0;
    // Pi retitles its process, so find it as our direct child (spawned detached, so it leads its own group).
    const pidsOf = () => Bun.spawnSync(["pgrep", "-P", String(process.pid), "-x", "pi"]).stdout.toString().split("\n").filter(Boolean).map(Number);
    const before = pidsOf();
    const child = runner().start(spec());
    for (let i = 0; i < 100 && bodies.length === 0; i++) await Bun.sleep(200);
    expect(bodies.length).toBeGreaterThan(0); // the model request is in flight
    const pids = pidsOf().filter((p) => !before.includes(p));
    expect(pids.length).toBeGreaterThan(0);
    await child.cancel();
    expect((await child.done).status).toBe("cancelled");
    for (const pid of pids) {
      expect(alive(pid)).toBe(false);
      expect(() => process.kill(-pid, 0)).toThrow(); // whole process group is gone too
    }
  });

  T("(f) steer is accepted while running and the run still completes", async () => {
    script = "hang";
    bodies.length = 0;
    const child = runner().start(spec({ timeoutMs: 8000 }));
    for (let i = 0; i < 100 && bodies.length === 0; i++) await Bun.sleep(200);
    await child.steer("change course"); // must not throw: Pi acks with disposition queued
    await child.cancel();
    expect((await child.done).status).toBe("cancelled");
    await expect(child.steer("late")).rejects.toThrow();
  });

  T("(g) restricted tools: request body lists exactly those tools", async () => {
    script = "text";
    bodies.length = 0;
    expect((await runner().start(spec({ tools: ["read"] })).done).status).toBe("completed");
    expect(bodies[0].tools.map((t: any) => t.function.name)).toEqual(["read"]);
    bodies.length = 0;
    expect((await runner().start(spec({ tools: [] })).done).status).toBe("completed");
    expect(bodies[0].tools ?? []).toEqual([]);
  });

  T("(h) --no-extensions prevents loading extensions (control run does load)", async () => {
    script = "text";
    const marker = join(agentDir, "marker");
    expect((await runner().start(spec()).done).status).toBe("completed");
    expect(existsSync(marker)).toBe(false);
    const p = rawPi([], ["--no-extensions"]);
    try {
      await p.conn.send({ type: "get_state" }, 20_000);
      expect(existsSync(marker)).toBe(true); // control: the marker extension is loadable
    } finally { await p.stop(); }
  });
});
