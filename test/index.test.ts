import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../src/index.ts";
import type { Child, RunResult, RunSpec, Runner } from "../src/types.ts";

const ok = (text: string): RunResult => ({ status: "completed", text, truncated: false });

interface Ctl { spec: RunSpec; finish(r: RunResult): void; steered: string[]; cancelled: number }

function harness(branch: unknown[] = [], failSend = { on: false }) {
  const handlers: Record<string, (e: any, c: any) => any> = {};
  const sent: { msg: any; opts: any }[] = [];
  const entries: { type: string; data: any }[] = [];
  let tool: any;
  const ctls: Ctl[] = [];
  const runner: Runner = {
    start(spec): Child {
      let resolve!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => (resolve = r));
      const ctl: Ctl = { spec, finish: resolve, steered: [], cancelled: 0 };
      ctls.push(ctl);
      return {
        done,
        steer: async (m) => void ctl.steered.push(m),
        cancel: async () => {
          ctl.cancelled++;
          resolve({ status: "cancelled", text: "", truncated: false });
        },
      };
    },
  };
  const pi = {
    registerTool: (t: any) => (tool = t),
    registerCommand: () => {},
    on: (n: string, h: any) => (handlers[n] = h),
    sendMessage: (msg: any, opts: any) => {
      if (failSend.on) throw new Error("send failed");
      sent.push({ msg, opts });
    },
    appendEntry: (type: string, data: any) => entries.push({ type, data }),
  };
  register(pi as any, runner);
  let idle = true;
  const ctx = (cwd: string, trusted = true) => ({
    cwd, isProjectTrusted: () => trusted, isIdle: () => idle, model: undefined, thinkingLevel: "low",
    sessionManager: { getBranch: () => branch },
  });
  return { handlers, sent, entries, tool, ctls, ctx, setIdle: (v: boolean) => (idle = v) };
}

let dirs: string[] = [];
async function project() {
  const cwd = await mkdtemp(join(tmpdir(), "psu-"));
  dirs.push(cwd);
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(join(cwd, ".pi", "agents", "scout.md"), "---\nname: scout\ndescription: Explore\ntools: read,grep\n---\nBe brief.");
  return cwd;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});
/** Wait until n children have been started (first call pays the cold dynamic imports). */
async function started(h: { ctls: unknown[] }, n = 1) {
  for (let i = 0; i < 2000 && h.ctls.length < n; i++) await new Promise((r) => setTimeout(r, 1));
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const run = (h: ReturnType<typeof harness>, cwd: string, p: object, signal?: AbortSignal) =>
  h.tool.execute("t", p, signal, undefined, h.ctx(cwd));
const txt = (r: any) => r.content[0].text as string;

test("registers one tool with a short description", () => {
  const h = harness();
  expect(h.tool.name).toBe("subagent");
  expect(h.tool.description.length).toBeLessThan(130);
});

test("start with wait returns the result and consumes it", async () => {
  const cwd = await project();
  const h = harness();
  h.handlers.session_start!({}, h.ctx(cwd));
  h.setIdle(false); // a waiting tool call means the orchestrator is mid-turn
  const p = run(h, cwd, { action: "start", agent: "scout", task: "look", wait: true });
  await started(h);
  h.ctls[0]!.finish(ok("found it"));
  expect(txt(await p)).toContain("found it");
  expect(h.ctls[0]!.spec).toMatchObject({ task: "look", systemPrompt: "Be brief.", tools: ["read", "grep"] });
  expect(h.sent.length).toBe(0); // consumed by the waiting call, no wakeup
});

test("background start returns an id immediately", async () => {
  const cwd = await project();
  const h = harness();
  expect(txt(await run(h, cwd, { action: "start", agent: "scout", task: "x" }))).toMatch(/^started /);
});

test("idle completions wake once and the wakeup drains everything finished", async () => {
  const cwd = await project();
  const h = harness();
  h.handlers.session_start!({}, h.ctx(cwd));
  await run(h, cwd, { action: "start", agent: "scout", task: "a" });
  await run(h, cwd, { action: "start", agent: "scout", task: "b" });
  h.setIdle(false); // both finish while the orchestrator is mid-turn
  h.ctls[0]!.finish(ok("A done"));
  h.ctls[1]!.finish(ok("B done"));
  await tick();
  expect(h.sent.length).toBe(0);
  h.setIdle(true);
  h.handlers.agent_settled!({}, h.ctx(cwd));
  expect(h.sent.length).toBe(1);
  expect(h.sent[0]!.msg.content).toContain("A done");
  expect(h.sent[0]!.msg.content).toContain("B done");
  expect(h.sent[0]!.opts.triggerTurn).toBe(true);
  h.handlers.agent_settled!({}, h.ctx(cwd)); // nothing left, no repeat wakeup
  expect(h.sent.length).toBe(1);
});

test("a result read mid-turn never wakes the orchestrator afterwards", async () => {
  const cwd = await project();
  const h = harness();
  h.handlers.session_start!({}, h.ctx(cwd));
  const a = txt(await run(h, cwd, { action: "start", agent: "scout", task: "a" })).split(" ")[1]!;
  const b = txt(await run(h, cwd, { action: "start", agent: "scout", task: "b" })).split(" ")[1]!;
  h.setIdle(false);
  h.ctls[0]!.finish(ok("A done"));
  await tick();
  h.setIdle(true);
  h.handlers.agent_settled!({}, h.ctx(cwd)); // wakeup for A
  expect(h.sent.length).toBe(1);
  h.setIdle(false); // new turn: B finishes, orchestrator reads it
  h.ctls[1]!.finish(ok("B done"));
  await tick();
  expect(txt(await run(h, cwd, { action: "status", id: b }))).toContain("B done");
  h.setIdle(true);
  h.handlers.agent_settled!({}, h.ctx(cwd));
  expect(h.sent.length).toBe(1);
  expect(txt(await run(h, cwd, { action: "inbox" }))).toBe("no finished jobs pending");
  expect(a).not.toBe(b);
});

test("inbox action drains pending completions", async () => {
  const cwd = await project();
  const h = harness();
  h.handlers.session_start!({}, h.ctx(cwd));
  await run(h, cwd, { action: "start", agent: "scout", task: "a" });
  h.setIdle(false);
  h.ctls[0]!.finish(ok("A done"));
  await tick();
  expect(txt(await run(h, cwd, { action: "inbox" }))).toContain("A done");
  h.setIdle(true);
  h.handlers.agent_settled!({}, h.ctx(cwd));
  expect(h.sent.length).toBe(0);
});

test("steer and cancel reach the child", async () => {
  const cwd = await project();
  const h = harness();
  const id = txt(await run(h, cwd, { action: "start", agent: "scout", task: "a" })).split(" ")[1]!;
  await run(h, cwd, { action: "steer", id, message: "focus" });
  expect(h.ctls[0]!.steered).toEqual(["focus"]);
  expect(txt(await run(h, cwd, { action: "cancel", id }))).toContain("cancelled");
  await expect(run(h, cwd, { action: "steer", id, message: "late" })).rejects.toThrow();
});

test("validation and trust", async () => {
  const cwd = await project();
  const h = harness();
  await expect(run(h, cwd, { action: "start" })).rejects.toThrow("requires");
  await expect(run(h, cwd, { action: "steer", id: "x" })).rejects.toThrow("requires");
  const r = await h.tool.execute("t", { action: "agents" }, undefined, undefined, h.ctx(cwd, false));
  expect(txt(r)).not.toContain("scout");
});

test("failed waited job throws with kind", async () => {
  const cwd = await project();
  const h = harness();
  const p = run(h, cwd, { action: "start", agent: "scout", task: "a", wait: true });
  await started(h);
  h.ctls[0]!.finish({ status: "failed", text: "", truncated: false, failure: { kind: "provider", message: "500" } });
  await expect(p).rejects.toThrow("provider");
});

test("abort signal cancels a waited job", async () => {
  const cwd = await project();
  const h = harness();
  const ac = new AbortController();
  const p = run(h, cwd, { action: "start", agent: "scout", task: "a", wait: true }, ac.signal);
  await started(h);
  ac.abort();
  await p;
  expect(h.ctls[0]!.cancelled).toBe(1);
});

test("restart reports running jobs as interrupted once, without waking", async () => {
  const rec = { id: "j1", agent: "scout", task: "t", state: "running", createdAt: 1, delivered: false };
  const h = harness([{ type: "custom", customType: "subagent-job", data: rec }]);
  await h.handlers.session_start!({}, h.ctx("/tmp"));
  expect(h.sent[0]!.msg.content).toContain("j1");
  expect(h.sent[0]!.opts.triggerTurn).toBe(false);
  expect(h.entries[0]!.data.state).toBe("interrupted");
});

test("shutdown cancels running jobs", async () => {
  const cwd = await project();
  const h = harness();
  await run(h, cwd, { action: "start", agent: "scout", task: "a" });
  await h.handlers.session_shutdown!({ reason: "quit" }, h.ctx(cwd));
  expect(h.ctls[0]!.cancelled).toBe(1);
});

test("cancel consumes its record so no later wakeup repeats it", async () => {
  const cwd = await project();
  const h = harness();
  h.handlers.session_start!({}, h.ctx(cwd));
  const id = txt(await run(h, cwd, { action: "start", agent: "scout", task: "a" })).split(" ")[1]!;
  h.setIdle(false);
  await run(h, cwd, { action: "cancel", id });
  h.setIdle(true);
  h.handlers.agent_settled!({}, h.ctx(cwd));
  expect(h.sent.length).toBe(0);
});

test("after a user abort pending results are delivered without restarting the agent", async () => {
  const cwd = await project();
  const h = harness();
  h.handlers.session_start!({}, h.ctx(cwd));
  await run(h, cwd, { action: "start", agent: "scout", task: "a" });
  h.setIdle(false);
  h.ctls[0]!.finish(ok("A done"));
  await tick();
  h.setIdle(true);
  h.handlers.agent_settled!({ aborted: true }, h.ctx(cwd));
  expect(h.sent.length).toBe(1);
  expect(h.sent[0]!.opts.triggerTurn).toBe(false);
});

test("a failed send puts results back and the next flush delivers them", async () => {
  const cwd = await project();
  const fail = { on: false };
  const h = harness([], fail);
  h.handlers.session_start!({}, h.ctx(cwd));
  await run(h, cwd, { action: "start", agent: "scout", task: "a" });
  h.setIdle(false);
  h.ctls[0]!.finish(ok("A done"));
  await tick();
  fail.on = true;
  h.setIdle(true);
  expect(() => h.handlers.agent_settled!({}, h.ctx(cwd))).toThrow();
  fail.on = false;
  h.handlers.agent_settled!({}, h.ctx(cwd));
  expect(h.sent.length).toBe(1);
  expect(h.sent[0]!.msg.content).toContain("A done");
});

test("no second wake while one is in flight, cleared when the agent starts", async () => {
  const cwd = await project();
  const h = harness();
  h.handlers.session_start!({}, h.ctx(cwd));
  await run(h, cwd, { action: "start", agent: "scout", task: "a" });
  await run(h, cwd, { action: "start", agent: "scout", task: "b" });
  h.ctls[0]!.finish(ok("A done")); // idle: wakes now
  await tick();
  h.ctls[1]!.finish(ok("B done")); // still idle (wake deferred): must not wake again
  await tick();
  expect(h.sent.length).toBe(1);
  h.handlers.agent_start!({}, h.ctx(cwd));
  h.handlers.agent_settled!({}, h.ctx(cwd));
  expect(h.sent.length).toBe(2);
  expect(h.sent[1]!.msg.content).toContain("B done");
});
