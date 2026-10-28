import type { Child, RunResult, RunSpec, Runner } from "./types.ts";

export type JobState = "queued" | "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface JobRecord {
  id: string;
  agent: string;
  /** First 200 chars of the task. */
  task: string;
  state: JobState;
  createdAt: number;
  /** When it left the queue; display only, not persisted. */
  startedAt?: number;
  endedAt?: number;
  result?: RunResult;
  delivered: boolean;
  /** Shown to the model with the result, e.g. where isolated work was kept. */
  note?: string;
  /** Latest assistant text, for the status widget only. Never persisted. */
  activity?: string;
}

export interface StartRequest {
  agent: string;
  spec: RunSpec;
}

export interface Jobs {
  start(req: StartRequest): JobRecord;
  get(id: string): JobRecord | undefined;
  list(): JobRecord[];
  cancel(id: string): Promise<JobRecord>;
  steer(id: string, message: string): Promise<void>;
  /** Resolves when the job is terminal. */
  wait(id: string): Promise<JobRecord>;
  shutdown(graceMs?: number): Promise<void>;
  readonly active: number;
}

const TERMINAL = new Set<JobState>(["completed", "failed", "cancelled", "interrupted"]);
const isTerminal = (s: JobState) => TERMINAL.has(s);

/** Latest record per id; anything not terminal had no live owner, so it is interrupted. */
export function restoreInterrupted(entries: JobRecord[]): JobRecord[] {
  const latest = new Map<string, JobRecord>();
  for (const e of entries) latest.set(e.id, e);
  return [...latest.values()].map((r) => (isTerminal(r.state) ? { ...r } : { ...r, state: "interrupted" }));
}

interface Entry {
  rec: JobRecord;
  req: StartRequest;
  child?: Child;
  /** Holds a concurrency slot. */
  holding: boolean;
  cancelP?: Promise<JobRecord>;
  settled: Promise<JobRecord>;
  resolve: (r: JobRecord) => void;
}

export function createJobs(opts: {
  runner: Runner;
  /** Concurrent child Pi processes. Default 6. */
  maxConcurrent?: number;
  /** Concurrent in-process agents. Default 50. */
  maxInprocess?: number;
  maxOutstanding?: number;
  maxHistory?: number;
  onTerminal?: (r: JobRecord) => void;
  onChange?: (r: JobRecord) => void;
  /** The job produced output; `activity` is updated. Display hook only. */
  onActivity?: (r: JobRecord) => void;
  now?: () => number;
  id?: () => string;
}): Jobs {
  const limit = { rpc: opts.maxConcurrent ?? 6, inprocess: opts.maxInprocess ?? 50 };
  const maxOutstanding = opts.maxOutstanding ?? 128;
  const maxHistory = opts.maxHistory ?? 100;
  const now = opts.now ?? Date.now;
  let seq = 0;
  const newId = opts.id ?? (() => `job-${++seq}-${Math.random().toString(36).slice(2, 8)}`);

  const records = new Map<string, JobRecord>();
  const entries = new Map<string, Entry>(); // live runtime data only
  const queue: Entry[] = [];
  const history: string[] = [];
  const running = { rpc: 0, inprocess: 0 };
  const lane = (e: Entry) => (e.req.spec.inprocess ? "inprocess" : "rpc");
  let closed = false;
  let pumping = false;

  const notify = (fn: ((r: JobRecord) => void) | undefined, r: JobRecord) => {
    try {
      fn?.(r);
    } catch {
      // Observer failures must not corrupt job accounting.
    }
  };

  function settle(e: Entry, state: JobState, result?: RunResult): void {
    if (isTerminal(e.rec.state)) return;
    const qi = queue.indexOf(e);
    if (qi >= 0) queue.splice(qi, 1);
    if (e.holding) {
      e.holding = false;
      running[lane(e)]--;
    }
    e.rec.state = state;
    e.rec.endedAt = now();
    if (result) e.rec.result = result;
    entries.delete(e.rec.id);
    history.push(e.rec.id);
    while (history.length > maxHistory) records.delete(history.shift()!);
    notify(opts.onChange, e.rec);
    notify(opts.onTerminal, e.rec);
    e.resolve(e.rec);
    pump();
  }

  const failed = (kind: "launch" | "exit", err: unknown): RunResult => ({
    status: "failed",
    text: "",
    truncated: false,
    failure: { kind, message: err instanceof Error ? err.message : String(err) },
  });

  function launch(e: Entry): void {
    e.holding = true;
    running[lane(e)]++;
    e.rec.state = "starting";
    e.rec.startedAt = now();
    notify(opts.onChange, e.rec);
    if (isTerminal(e.rec.state)) return; // an observer may cancel before spawn
    let child: Child;
    try {
      child = opts.runner.start({
        ...e.req.spec,
        onActivity: (t) => {
          if (isTerminal(e.rec.state) || !t.trim()) return;
          e.rec.activity = t.slice(0, 200);
          notify(opts.onActivity, e.rec);
        },
      });
    } catch (err) {
      settle(e, "failed", failed("launch", err));
      return;
    }
    e.child = child;
    if (isTerminal(e.rec.state)) {
      // Cancelled by an observer while starting.
      child.cancel().catch(() => {});
    } else {
      e.rec.state = "running";
      notify(opts.onChange, e.rec);
    }
    child.done.then(
      (r) => settle(e, r.status, r),
      (err) => settle(e, "failed", failed("exit", err)),
    );
  }

  function pump(): void {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        if (closed) return;
        // First queued job whose own lane has room, so a full RPC lane never blocks in-process agents.
        const i = queue.findIndex((q) => running[lane(q)] < limit[lane(q)]);
        if (i < 0) return;
        launch(queue.splice(i, 1)[0]!);
      }
    } finally {
      pumping = false;
    }
  }

  function need(id: string): JobRecord {
    const rec = records.get(id);
    if (!rec) throw new Error(`unknown job ${id}`);
    return rec;
  }

  function cancel(id: string): Promise<JobRecord> {
    const rec = need(id);
    if (isTerminal(rec.state)) return Promise.resolve(rec);
    const e = entries.get(id)!;
    if (e.cancelP) return e.cancelP;
    if (!e.child) {
      settle(e, "cancelled");
      return Promise.resolve(e.rec);
    }
    // Final state is whatever the child reports first; a failed cancel forces cancelled.
    e.cancelP = e.child.cancel().then(
      () => e.settled,
      () => (settle(e, "cancelled"), e.settled),
    );
    return e.cancelP;
  }

  return {
    start(req) {
      if (closed) throw new Error("jobs are shut down");
      if (entries.size >= maxOutstanding) throw new Error(`too many outstanding jobs (${maxOutstanding}); wait for or cancel some`);
      const id = newId();
      let resolve!: (r: JobRecord) => void;
      const settled = new Promise<JobRecord>((r) => (resolve = r));
      const rec: JobRecord = {
        id,
        agent: req.agent,
        task: req.spec.task.slice(0, 200),
        state: "queued",
        createdAt: now(),
        delivered: false,
      };
      const e: Entry = { rec, req, holding: false, settled, resolve };
      records.set(id, rec);
      entries.set(id, e);
      queue.push(e);
      notify(opts.onChange, rec);
      pump();
      return rec;
    },
    get: (id) => records.get(id),
    list: () => [...records.values()],
    cancel,
    async steer(id, message) {
      const rec = need(id);
      const child = entries.get(id)?.child;
      if (rec.state !== "running" || !child) throw new Error(`job ${id} is ${rec.state}, not running`);
      await child.steer(message);
    },
    wait: (id) => {
      const rec = need(id);
      return entries.get(id)?.settled ?? Promise.resolve(rec);
    },
    async shutdown(graceMs = 5000) {
      closed = true;
      for (const e of [...queue]) settle(e, "cancelled");
      const live = [...entries.values()];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((r) => (timer = setTimeout(r, graceMs)));
      await Promise.race([Promise.all(live.map((e) => cancel(e.rec.id))), grace]);
      clearTimeout(timer);
      for (const e of live) settle(e, "cancelled");
    },
    get active() {
      return running.rpc + running.inprocess;
    },
  };
}
