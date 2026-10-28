import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { harness, ok, project as mkProject, run, started, tick, txt } from "./helpers/harness.ts";

let dirs: string[] = [];
const project = () => mkProject(dirs);
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

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

test("results unread at shutdown are shown once after the restart, without waking", async () => {
  const cwd = await project();
  const h = harness();
  h.handlers.session_start!({}, h.ctx(cwd));
  await run(h, cwd, { action: "start", agent: "scout", task: "a" });
  await run(h, cwd, { action: "start", agent: "scout", task: "b" });
  h.setIdle(false);
  h.ctls[0]!.finish(ok("A finished unread"));
  await tick();
  await h.handlers.session_shutdown!({ reason: "quit" }, h.ctx(cwd)); // B is cancelled by shutdown, A is real
  const unread = h.entries.filter((e) => e.type === "subagent-unread");
  expect(unread.length).toBe(1);
  expect(unread[0]!.data.records.map((r: any) => r.id).length).toBe(1);

  const branch = h.entries.map((e) => ({ type: "custom", customType: e.type, data: e.data }));
  const h2 = harness(branch);
  await h2.handlers.session_start!({}, h2.ctx(cwd));
  expect(h2.sent.length).toBe(1);
  expect(h2.sent[0]!.msg.content).toContain("A finished unread");
  expect(h2.sent[0]!.opts.triggerTurn).toBe(false);

  const branch2 = [...branch, ...h2.entries.map((e) => ({ type: "custom", customType: e.type, data: e.data }))];
  const h3 = harness(branch2);
  await h3.handlers.session_start!({}, h3.ctx(cwd)); // acked, so not shown again
  expect(h3.sent.length).toBe(0);
});
