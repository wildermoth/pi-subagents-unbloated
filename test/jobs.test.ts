import { describe, expect, test } from "bun:test";
import { createJobs, isWriter, restoreInterrupted, type JobRecord, type StartRequest } from "../src/jobs.ts";
import type { Child, RunResult, RunSpec, Runner } from "../src/types.ts";

const ok = (text = "ok"): RunResult => ({ status: "completed", text, truncated: false });
const cancelled = (): RunResult => ({ status: "cancelled", text: "", truncated: false });

class FakeChild implements Child {
  done: Promise<RunResult>;
  finish!: (r: RunResult) => void;
  fail!: (e: unknown) => void;
  cancels = 0;
  steers: string[] = [];
  /** What cancel() does: settle as cancelled by default. */
  onCancel: () => void | Promise<void> = () => this.finish(cancelled());
  constructor(public spec: RunSpec) {
    this.done = new Promise((res, rej) => ((this.finish = res), (this.fail = rej)));
  }
  async steer(m: string) {
    this.steers.push(m);
  }
  async cancel() {
    this.cancels++;
    await this.onCancel();
  }
}

function fake() {
  const children: FakeChild[] = [];
  let throwOnStart = false;
  const runner: Runner = {
    start(spec) {
      if (throwOnStart) throw new Error("spawn failed");
      const c = new FakeChild(spec);
      children.push(c);
      return c;
    },
  };
  return { runner, children, failNext: () => (throwOnStart = true), okNext: () => (throwOnStart = false) };
}

const spec = (task = "t"): RunSpec => ({
  cwd: "/", task, systemPrompt: "", trusted: true, timeoutMs: 1, launchTimeoutMs: 1,
});
const req = (o: Partial<StartRequest> = {}): StartRequest => ({
  agent: "a", spec: spec(), writes: false, repoKey: "r", ...o,
});
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("isWriter", () => {
  test("rules", () => {
    expect(isWriter()).toBe(true);
    expect(isWriter(["read", "grep", "find", "ls"])).toBe(false);
    expect(isWriter([])).toBe(false);
    expect(isWriter(["read", "bash"])).toBe(true);
    expect(isWriter(["edit"])).toBe(true);
  });
});

describe("jobs", () => {
  test("unique ids, task truncated, lifecycle to completed", async () => {
    const f = fake();
    const terminal: JobRecord[] = [];
    const jobs = createJobs({ runner: f.runner, onTerminal: (r) => terminal.push(r) });
    const a = jobs.start(req({ spec: spec("x".repeat(500)) }));
    const b = jobs.start(req());
    expect(a.id).not.toBe(b.id);
    expect(a.task.length).toBe(200);
    expect(a.state).toBe("running");
    expect(jobs.active).toBe(2);
    f.children[0]!.finish(ok("A"));
    const done = await jobs.wait(a.id);
    expect(done.state).toBe("completed");
    expect(done.result?.text).toBe("A");
    expect(done.endedAt).toBeDefined();
    expect(jobs.active).toBe(1);
    expect(terminal.map((r) => r.id)).toEqual([a.id]);
  });

  test("states observed forward only via onChange", async () => {
    const f = fake();
    const seen: string[] = [];
    const jobs = createJobs({ runner: f.runner, maxConcurrent: 1, onChange: (r) => seen.push(`${r.id}:${r.state}`), id: (() => { let n = 0; return () => `j${++n}`; })() });
    jobs.start(req());
    jobs.start(req());
    f.children[0]!.finish(ok());
    await jobs.wait("j1");
    f.children[1]!.finish(ok());
    await jobs.wait("j2");
    expect(seen).toEqual([
      "j1:queued", "j1:starting", "j1:running", "j2:queued",
      "j1:completed", "j2:starting", "j2:running", "j2:completed",
    ]);
  });

  test("two jobs finishing in the same turn, either order", async () => {
    for (const order of [[0, 1], [1, 0]]) {
      const f = fake();
      const terminal: string[] = [];
      const jobs = createJobs({ runner: f.runner, onTerminal: (r) => terminal.push(r.id) });
      const a = jobs.start(req());
      const b = jobs.start(req());
      for (const i of order) f.children[i]!.finish(ok());
      await Promise.all([jobs.wait(a.id), jobs.wait(b.id)]);
      expect(terminal.sort()).toEqual([a.id, b.id].sort());
      expect(jobs.active).toBe(0);
    }
  });

  test("done rejecting is failed/exit and frees slot", async () => {
    const f = fake();
    const jobs = createJobs({ runner: f.runner, maxConcurrent: 1 });
    const a = jobs.start(req());
    const b = jobs.start(req());
    expect(b.state).toBe("queued");
    f.children[0]!.fail(new Error("boom"));
    const r = await jobs.wait(a.id);
    expect(r.state).toBe("failed");
    expect(r.result?.failure).toEqual({ kind: "exit", message: "boom" });
    expect(b.state).toBe("running");
    expect(jobs.active).toBe(1);
  });

  test("runner.start throwing fails with launch and releases the slot", async () => {
    const f = fake();
    const terminal: JobRecord[] = [];
    const jobs = createJobs({ runner: f.runner, maxConcurrent: 1, onTerminal: (r) => terminal.push(r) });
    f.failNext();
    const a = jobs.start(req({ writes: true }));
    expect(a.state).toBe("failed");
    expect(a.result?.failure?.kind).toBe("launch");
    expect(jobs.active).toBe(0);
    expect(terminal.length).toBe(1);
    f.okNext();
    const b = jobs.start(req({ writes: true }));
    expect(b.state).toBe("running");
  });

  test("a queued job whose launch throws does not stall the queue", async () => {
    const f = fake();
    const jobs = createJobs({ runner: f.runner, maxConcurrent: 1 });
    jobs.start(req());
    const b = jobs.start(req());
    const c = jobs.start(req());
    f.failNext();
    f.children[0]!.finish(ok());
    await tick();
    expect(b.state).toBe("failed");
    expect(c.state).toBe("failed");
    expect(jobs.active).toBe(0);
  });

  test("outstanding jobs are capped and a finished job frees room", async () => {
    const f = fake();
    const jobs = createJobs({ runner: f.runner, maxConcurrent: 1, maxOutstanding: 2 });
    const a = jobs.start(req());
    const b = jobs.start(req());
    expect(() => jobs.start(req())).toThrow(/too many outstanding jobs \(2\)/);
    f.children[0]!.finish(ok());
    await jobs.wait(a.id);
    expect(jobs.start(req()).state).toBe("queued");
    expect(b.state).toBe("running");
  });

  test("queue saturation, FIFO, and cancel of queued never spawns", async () => {
    const f = fake();
    const jobs = createJobs({ runner: f.runner, maxConcurrent: 2 });
    const [a, b, c, d, e] = [1, 2, 3, 4, 5].map(() => jobs.start(req()));
    expect(f.children.length).toBe(2);
    expect([c!, d!, e!].map((j) => j.state)).toEqual(["queued", "queued", "queued"]);
    const cc = await jobs.cancel(d!.id);
    expect(cc.state).toBe("cancelled");
    expect(f.children.length).toBe(2);
    f.children[0]!.finish(ok());
    await jobs.wait(a!.id);
    expect(c!.state).toBe("running");
    expect(e!.state).toBe("queued");
    f.children[1]!.finish(ok());
    await jobs.wait(b!.id);
    expect(e!.state).toBe("running");
    expect(f.children.length).toBe(4);
    expect(d!.state).toBe("cancelled");
  });

  test("writers serialize per repo; blocked writer does not block others", async () => {
    const f = fake();
    const jobs = createJobs({ runner: f.runner, maxConcurrent: 4 });
    const w1 = jobs.start(req({ writes: true, repoKey: "x" }));
    const w2 = jobs.start(req({ writes: true, repoKey: "x" }));
    const r1 = jobs.start(req({ writes: false, repoKey: "x" }));
    const w3 = jobs.start(req({ writes: true, repoKey: "y" }));
    expect(w1.state).toBe("running");
    expect(w2.state).toBe("queued");
    expect(r1.state).toBe("running");
    expect(w3.state).toBe("running");
    f.children[0]!.finish(ok());
    await jobs.wait(w1.id);
    expect(w2.state).toBe("running");
  });

  test("blocked writer at queue head is skipped when slot frees", async () => {
    const f = fake();
    const jobs = createJobs({ runner: f.runner, maxConcurrent: 2 });
    jobs.start(req({ writes: true, repoKey: "x" }));
    jobs.start(req());
    const w2 = jobs.start(req({ writes: true, repoKey: "x" }));
    const r = jobs.start(req());
    expect([w2.state, r.state]).toEqual(["queued", "queued"]);
    f.children[1]!.finish(ok()); // frees a slot, but writer repo still locked
    await tick();
    expect(w2.state).toBe("queued");
    expect(r.state).toBe("running");
  });

  test("cancel running (graceful) is idempotent", async () => {
    const f = fake();
    const jobs = createJobs({ runner: f.runner });
    const a = jobs.start(req());
    const [x, y] = await Promise.all([jobs.cancel(a.id), jobs.cancel(a.id)]);
    expect(x.state).toBe("cancelled");
    expect(y).toBe(x);
    await jobs.cancel(a.id);
    expect(f.children[0]!.cancels).toBe(1);
    expect(jobs.active).toBe(0);
  });

  test("cancel racing completion: first child report wins, never both", async () => {
    const f = fake();
    const terminal: JobRecord[] = [];
    const jobs = createJobs({ runner: f.runner, onTerminal: (r) => terminal.push(r) });
    const a = jobs.start(req());
    const c = f.children[0]!;
    c.onCancel = () => {}; // child reports on its own
    const p = jobs.cancel(a.id);
    c.finish(ok("won"));
    c.finish(cancelled()); // ignored
    expect((await p).state).toBe("completed");
    expect(terminal.length).toBe(1);
    expect((await jobs.cancel(a.id)).state).toBe("completed");
  });

  test("cancel() rejecting forces cancelled and frees slot", async () => {
    const f = fake();
    const jobs = createJobs({ runner: f.runner });
    const a = jobs.start(req());
    f.children[0]!.onCancel = () => Promise.reject(new Error("x"));
    expect((await jobs.cancel(a.id)).state).toBe("cancelled");
    f.children[0]!.finish(ok()); // late, ignored
    await tick();
    expect(a.state).toBe("cancelled");
    expect(jobs.active).toBe(0);
  });

  test("steer: running ok, queued/terminal/unknown rejected", async () => {
    const f = fake();
    const jobs = createJobs({ runner: f.runner, maxConcurrent: 1 });
    const a = jobs.start(req());
    const b = jobs.start(req());
    await jobs.steer(a.id, "hi");
    expect(f.children[0]!.steers).toEqual(["hi"]);
    await expect(jobs.steer(b.id, "x")).rejects.toThrow(/queued, not running/);
    f.children[0]!.finish(ok());
    await jobs.wait(a.id);
    await expect(jobs.steer(a.id, "x")).rejects.toThrow(/completed, not running/);
    await expect(jobs.steer("nope", "x")).rejects.toThrow(/unknown job/);
    expect(f.children[0]!.steers).toEqual(["hi"]);
  });

  test("shutdown cancels queued and running, then rejects start", async () => {
    const f = fake();
    const terminal: JobRecord[] = [];
    const jobs = createJobs({ runner: f.runner, maxConcurrent: 1, onTerminal: (r) => terminal.push(r) });
    const a = jobs.start(req());
    const b = jobs.start(req());
    await jobs.shutdown();
    expect(a.state).toBe("cancelled");
    expect(b.state).toBe("cancelled");
    expect(f.children.length).toBe(1);
    expect(jobs.active).toBe(0);
    expect(terminal.length).toBe(2);
    expect(jobs.list().some((j) => !["cancelled", "completed", "failed"].includes(j.state))).toBe(false);
    expect(() => jobs.start(req())).toThrow(/shut down/);
  });

  test("shutdown forces a child that ignores cancel after grace", async () => {
    const f = fake();
    const jobs = createJobs({ runner: f.runner });
    const a = jobs.start(req());
    f.children[0]!.onCancel = () => {};
    await jobs.shutdown(10);
    expect(a.state).toBe("cancelled");
    expect(jobs.active).toBe(0);
  });

  test("history evicts old terminal records, never live ones", async () => {
    const f = fake();
    const jobs = createJobs({ runner: f.runner, maxConcurrent: 10, maxHistory: 2 });
    const live = jobs.start(req());
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const j = jobs.start(req());
      ids.push(j.id);
      f.children[i + 1]!.finish(ok());
      await jobs.wait(j.id);
    }
    expect(jobs.get(ids[0]!)).toBeUndefined();
    expect(jobs.get(ids[1]!)).toBeUndefined();
    expect(jobs.get(ids[3]!)).toBeDefined();
    expect(jobs.get(live.id)?.state).toBe("running");
    expect(jobs.list().length).toBe(3);
  });

  test("observer cancellation before spawn never launches or retains a writer lock", async () => {
    const f = fake();
    let cancelStarting = true;
    const terminal: string[] = [];
    const jobs = createJobs({
      runner: f.runner,
      onChange: (r) => {
        if (cancelStarting && r.state === "starting") void jobs.cancel(r.id);
      },
      onTerminal: (r) => terminal.push(r.id),
    });
    const cancelled = jobs.start(req({ writes: true }));
    expect(cancelled.state).toBe("cancelled");
    expect(f.children).toHaveLength(0);
    expect(jobs.active).toBe(0);
    expect(await jobs.wait(cancelled.id)).toBe(cancelled);
    expect(terminal).toEqual([cancelled.id]);
    cancelStarting = false;
    expect(jobs.start(req({ writes: true })).state).toBe("running");
  });

  test("terminal history preserves record identity and completed APIs", async () => {
    const f = fake();
    const jobs = createJobs({ runner: f.runner });
    const r = jobs.start(req());
    const waiting = jobs.wait(r.id);
    f.children[0]!.finish(ok("kept"));
    expect(await waiting).toBe(r);
    r.delivered = true;
    expect(jobs.get(r.id)).toBe(r);
    expect(jobs.list()).toEqual([r]);
    expect(await jobs.wait(r.id)).toBe(r);
    expect(await jobs.cancel(r.id)).toBe(r);
    expect(f.children[0]!.cancels).toBe(0);
    await expect(jobs.steer(r.id, "late")).rejects.toThrow("completed, not running");
    await jobs.shutdown();
    expect(jobs.get(r.id)?.result?.text).toBe("kept");
    expect(jobs.get(r.id)?.delivered).toBe(true);
  });

  test("observer throwing does not leak slots", async () => {
    const f = fake();
    const jobs = createJobs({ runner: f.runner, onTerminal: () => { throw new Error("obs"); } });
    const a = jobs.start(req());
    f.children[0]!.finish(ok());
    await jobs.wait(a.id);
    expect(jobs.active).toBe(0);
  });

  test("random cancel/complete/fail races never leak slots or double-fire", async () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let iter = 0; iter < 200; iter++) {
      const f = fake();
      const counts = new Map<string, number>();
      const jobs = createJobs({
        runner: f.runner,
        maxConcurrent: 1 + Math.floor(rnd() * 3),
        onTerminal: (r) => counts.set(r.id, (counts.get(r.id) ?? 0) + 1),
      });
      const n = 3 + Math.floor(rnd() * 6);
      const recs: JobRecord[] = [];
      for (let i = 0; i < n; i++) {
        recs.push(jobs.start(req({ writes: rnd() < 0.5, repoKey: rnd() < 0.5 ? "x" : "y" })));
      }
      const ops: Promise<unknown>[] = [];
      let guard = 0;
      while (recs.some((r) => r.state !== "completed" && r.state !== "failed" && r.state !== "cancelled") && guard++ < 1000) {
        const r = recs[Math.floor(rnd() * n)]!;
        const idx = Math.floor(rnd() * f.children.length);
        const k = rnd();
        if (k < 0.3) ops.push(jobs.cancel(r.id));
        else if (f.children[idx]) {
          if (k < 0.65) f.children[idx].finish(ok());
          else if (k < 0.8) f.children[idx].fail(new Error("e"));
          else f.children[idx].finish(cancelled());
        }
        if (rnd() < 0.5) await tick();
      }
      await Promise.all(ops);
      await tick();
      expect(jobs.active).toBe(0);
      expect(counts.size).toBe(n);
      for (const v of counts.values()) expect(v).toBe(1);
    }
  });
});

describe("restoreInterrupted", () => {
  const rec = (id: string, state: JobRecord["state"]): JobRecord => ({
    id, agent: "a", task: "t", state, createdAt: 1, delivered: false,
  });
  test("latest per id wins; non-terminal become interrupted", () => {
    const out = restoreInterrupted([
      rec("a", "queued"), rec("a", "running"), rec("b", "running"), rec("b", "completed"),
      rec("c", "starting"), rec("d", "failed"), rec("e", "queued"),
    ]);
    expect(Object.fromEntries(out.map((r) => [r.id, r.state]))).toEqual({
      a: "interrupted", b: "completed", c: "interrupted", d: "failed", e: "interrupted",
    });
  });
});
