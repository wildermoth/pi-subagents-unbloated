import type { Child, RunResult, RunSpec, Runner } from "./types.ts";

export type JobState =
  | "queued" | "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface JobRecord {
  id: string;
  agent: string;
  /** First 200 chars of the task. */
  task: string;
  state: JobState;
  createdAt: number;
  endedAt?: number;
  result?: RunResult;
  delivered: boolean;
}

export interface StartRequest {
  agent: string;
  spec: RunSpec;
  writes: boolean;
  repoKey: string;
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

const READ_ONLY = new Set(["read", "grep", "find", "ls"]);

/** Unknown tools (incl. bash) count as writing; no allowlist means defaults, which write. */
export function isWriter(tools?: string[]): boolean {
  return tools === undefined || tools.some((t) => !READ_ONLY.has(t));
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
  /** Holds a concurrency slot and (for writers) the repo lock. */
  holding: boolean;
  cancelP?: Promise<JobRecord>;
  settled: Promise<JobRecord>;
  resolve: (r: JobRecord) => void;
}

export function createJobs(opts: {
  runner: Runner;
  maxConcurrent?: number;
  maxHistory?: number;
  onTerminal?: (r: JobRecord) => void;
  onChange?: (r: JobRecord) => void;
  now?: () => number;
  id?: () => string;
}): Jobs {
  const max = opts.maxConcurrent ?? 4;
  const maxHistory = opts.maxHistory ?? 100;
  const now = opts.now ?? Date.now;
  let seq = 0;
  const newId = opts.id ?? (() => `job-${++seq}-${Math.random().toString(36).slice(2, 8)}`);

  const entries = new Map<string, Entry>();
  const queue: Entry[] = [];
  const history: string[] = [];
  const writerRepos = new Set<string>();
  let running = 0;
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
      running--;
      if (e.req.writes) writerRepos.delete(e.req.repoKey);
    }
    e.rec.state = state;
    e.rec.endedAt = now();
    if (result) e.rec.result = result;
    history.push(e.rec.id);
    while (history.length > maxHistory) entries.delete(history.shift()!);
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
    running++;
    if (e.req.writes) writerRepos.add(e.req.repoKey);
    e.rec.state = "starting";
    notify(opts.onChange, e.rec);
    let child: Child;
    try {
      child = opts.runner.start(e.req.spec);
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
        if (closed || running >= max) return;
        const next = queue.find((q) => !q.req.writes || !writerRepos.has(q.req.repoKey));
        if (!next) return;
        queue.splice(queue.indexOf(next), 1);
        launch(next);
      }
    } finally {
      pumping = false;
    }
  }

  function need(id: string): Entry {
    const e = entries.get(id);
    if (!e) throw new Error(`unknown job ${id}`);
    return e;
  }

  function cancel(id: string): Promise<JobRecord> {
    const e = need(id);
    if (isTerminal(e.rec.state)) return Promise.resolve(e.rec);
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
      entries.set(id, e);
      queue.push(e);
      notify(opts.onChange, rec);
      pump();
      return rec;
    },
    get: (id) => entries.get(id)?.rec,
    list: () => [...entries.values()].map((e) => e.rec),
    cancel,
    async steer(id, message) {
      const e = need(id);
      if (e.rec.state !== "running" || !e.child) throw new Error(`job ${id} is ${e.rec.state}, not running`);
      await e.child.steer(message);
    },
    wait: (id) => need(id).settled,
    async shutdown(graceMs = 5000) {
      closed = true;
      for (const e of [...queue]) settle(e, "cancelled");
      const live = [...entries.values()].filter((e) => !isTerminal(e.rec.state));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((r) => (timer = setTimeout(r, graceMs)));
      await Promise.race([Promise.all(live.map((e) => cancel(e.rec.id))), grace]);
      clearTimeout(timer);
      for (const e of live) settle(e, "cancelled");
    },
    get active() {
      return running;
    },
  };
}
