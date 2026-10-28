import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Inbox } from "./inbox.ts";
import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { JobRecord, Jobs } from "./jobs.ts";
import type { Workspace } from "./isolation.ts";
import type { Runner } from "./types.ts";

const TIMEOUT_MS = 30 * 60_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const JOB_ENTRY = "subagent-job";

/** Plain JSON Schema: avoids loading typebox and pi-ai at startup. */
const params = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["start", "list", "status", "steer", "cancel", "agents", "inbox", "diff", "apply", "discard"] },
    agent: { type: "string" },
    task: { type: "string", description: "Self-contained brief; the agent sees nothing else" },
    id: { type: "string" },
    message: { type: "string" },
    wait: { type: "boolean", description: "Block until finished (default: background)" },
    isolate: { type: "boolean", description: "Run in a git worktree; review with diff, then apply or discard" },
  },
  required: ["action"],
} as never;

interface Params {
  action: "start" | "list" | "status" | "steer" | "cancel" | "agents" | "inbox" | "diff" | "apply" | "discard";
  agent?: string;
  task?: string;
  id?: string;
  message?: string;
  wait?: boolean;
  isolate?: boolean;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
let agentsMod: Promise<typeof import("./agents.ts")> | undefined;
/** One shared import: Pi's loader hands concurrent first imports a half-initialised module. */
const agentsModule = () => (agentsMod ??= import("./agents.ts"));
let isoMod: Promise<typeof import("./isolation.ts")> | undefined;
const isolationModule = () => (isoMod ??= import("./isolation.ts"));
const WS_ENTRY = "subagent-workspace";
const UNREAD_ENTRY = "subagent-unread"; // results finished but never read when the session ended
const isDone = (r: JobRecord) => r.state === "completed" || r.state === "failed";
const MAX_DIFF_CHARS = 6000;
const line = (r: JobRecord) => `${r.id} ${r.agent} ${r.state}${r.delivered ? "" : r.result ? " (unread)" : ""}: ${r.task.slice(0, 60)}`;

export default function (pi: ExtensionAPI, injected?: Runner) {
  let ctx: ExtensionContext | undefined;
  let state: { jobs: Jobs; inbox: Inbox; isWriter: (tools?: string[]) => boolean } | undefined;
  let pending: ReturnType<typeof build> | undefined; // parallel first calls must share one state
  let interrupted: JobRecord[] = [];
  const workspaces = new Map<string, Workspace>(); // job id -> isolated worktree, kept until apply or discard

  let waking = false; // a wake is in flight; sendMessage defers inside agent_settled, so isIdle() stays true meanwhile

  /** The job's worktree, refusing while the job could still be writing to it. */
  function workspaceOf(id: string): Workspace {
    const ws = workspaces.get(id);
    if (!ws) throw new Error(`job ${id} has no isolated worktree`);
    const r = state?.jobs.get(id);
    if (r && !["completed", "failed", "cancelled"].includes(r.state)) throw new Error(`job ${id} is still ${r.state}; wait or cancel first`);
    return ws;
  }
  function forget(id: string) {
    workspaces.delete(id);
    pi.appendEntry(WS_ENTRY, { jobId: id, discarded: true });
  }

  /** Deliver everything finished and unread in one message. wake=false lands it in context without starting a turn. */
  function flush(wake: boolean) {
    if (!state || state.inbox.size === 0) return;
    const { inbox } = state;
    const records = inbox.drain();
    try {
      pi.sendMessage({ customType: "subagent-results", content: inbox.format(records), display: true }, { triggerTurn: wake });
      waking = wake;
    } catch (e) {
      inbox.requeue(records); // never lose a result to a failed send
      throw e;
    }
  }
  const flushIfIdle = (wake = true) => {
    let idle = false;
    try {
      idle = !!ctx?.isIdle();
    } catch {
      ctx = undefined; // stale after reload; session_start recaptures
      return;
    }
    if (idle && !waking) flush(wake);
  };

  function getState() {
    return (pending ??= build());
  }
  async function build() {
    // Lazy: nothing but the tool declaration loads at startup.
    const [{ createInbox }, { createJobs, isWriter }, runner] = await Promise.all([
      import("./inbox.ts"),
      import("./jobs.ts"),
      injected ?? import("./runner.ts").then((m) => m.createRunner()),
    ]);
    const inbox = createInbox({ onPublish: flushIfIdle });
    const jobs = createJobs({
      runner,
      onTerminal: (r) => inbox.publish(r),
      onChange: ({ id, agent, task, state: s, createdAt, endedAt, delivered }) =>
        pi.appendEntry(JOB_ENTRY, { id, agent, task, state: s, createdAt, endedAt, delivered }),
    });
    return (state = { jobs, inbox, isWriter });
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate tasks to independent agents. action=agents lists them; start runs one (background unless wait).",
    parameters: params,
    async execute(_id, args, signal, _onUpdate, c) {
      const p = args as Params;
      const need = (...k: ("agent" | "task" | "id" | "message")[]) => {
        const missing = k.filter((x) => !p[x]);
        if (missing.length) throw new Error(`${p.action} requires ${missing.join(", ")}`);
      };
      const { jobs, inbox, isWriter } = await getState();
      switch (p.action) {
        case "agents": {
          const { discoverAgents, listAgents } = await agentsModule();
          const { agents, warnings } = await discoverAgents({ cwd: c.cwd, projectTrusted: c.isProjectTrusted() });
          return text([listAgents(agents), ...warnings].filter(Boolean).join("\n") || "no agents defined");
        }
        case "start": {
          need("agent", "task");
          const { discoverAgents, resolveAgent } = await agentsModule();
          const { agents } = await discoverAgents({ cwd: c.cwd, projectTrusted: c.isProjectTrusted() });
          const def = resolveAgent(agents, p.agent!);
          const writes = isWriter(def.tools);
          let repoKey = c.cwd;
          let cwd = c.cwd;
          // Resolve only for writers/isolation, never during registration or discovery.
          if (writes || p.isolate) {
            cwd = await realpath(c.cwd);
            const iso = await isolationModule();
            repoKey = await iso.repoRootOf(cwd).catch((e) => {
              if (p.isolate) throw e;
              return cwd; // non-Git workspaces still serialize through canonical cwd
            });
          }
          let ws: Workspace | undefined;
          if (p.isolate) {
            const iso = await isolationModule();
            const root = repoKey;
            ws = await iso.create({ repoRoot: root, id: crypto.randomUUID().slice(0, 12) });
            cwd = join(ws.path, relative(root, cwd)); // root is canonical, so cwd must be too (macOS /var, Windows 8.3 names)
          }
          let rec: JobRecord;
          try {
            rec = jobs.start({
              agent: def.name,
              writes: !ws && writes, // an isolated writer cannot collide with anyone
              repoKey: ws ? ws.path : repoKey,
              spec: {
                cwd,
                task: p.task!,
                systemPrompt: def.prompt,
                tools: def.tools,
                model: def.model ?? (c.model ? `${c.model.provider}/${c.model.id}` : undefined),
                thinking: c.thinkingLevel,
                trusted: c.isProjectTrusted(),
                timeoutMs: TIMEOUT_MS,
                launchTimeoutMs: LAUNCH_TIMEOUT_MS,
              },
            });
          } catch (e) {
            if (ws) {
              try {
                await (await isolationModule()).discard(ws);
              } catch {
                throw new Error(`${(e as Error).message}; unused worktree left at ${ws.path}`);
              }
            }
            throw e;
          }
          if (ws) {
            workspaces.set(rec.id, ws);
            rec.note = `worktree kept: diff ${rec.id}, then apply or discard ${rec.id}`;
            pi.appendEntry(WS_ENTRY, { jobId: rec.id, ws });
          }
          if (!p.wait) return text(`started ${rec.id} (${def.name})`);
          const onAbort = () => void jobs.cancel(rec.id);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
          try {
            await jobs.wait(rec.id);
          } finally {
            signal?.removeEventListener("abort", onAbort);
          }
          inbox.take(rec.id); // consumed here, so no wakeup repeats it
          const out = inbox.format([rec]);
          if (rec.state === "failed") throw new Error(out);
          return text(out);
        }
        case "list":
          return text([...interrupted, ...jobs.list()].map((r) => line(r) + (workspaces.has(r.id) ? " [worktree]" : "")).join("\n") || "no jobs");
        case "status": {
          need("id");
          const r = jobs.get(p.id!) ?? interrupted.find((j) => j.id === p.id);
          if (!r) throw new Error(`unknown job ${p.id}`);
          const done = inbox.take(r.id); // reading output consumes it, so no later wakeup repeats it
          return text(done ? inbox.format([done]) : line(r));
        }
        case "steer":
          need("id", "message");
          await jobs.steer(p.id!, p.message!);
          return text(`steered ${p.id}`);
        case "cancel": {
          need("id");
          const r = await jobs.cancel(p.id!);
          inbox.take(r.id); // the caller is told here, a later wakeup would repeat it
          return text(`${r.id} ${r.state}`);
        }
        case "diff": {
          need("id");
          const { changed, diff, clean } = await (await isolationModule()).inspect(workspaceOf(p.id!));
          if (clean) return text("no changes");
          const head = `${changed.length} changed:\n${changed.slice(0, 50).join("\n")}`;
          const more = diff.length > MAX_DIFF_CHARS ? `\n[diff truncated, ${diff.length - MAX_DIFF_CHARS} more characters]` : "";
          return text(`${head}\n\n${diff.slice(0, MAX_DIFF_CHARS)}${more}`);
        }
        case "apply": {
          need("id");
          const ws = workspaceOf(p.id!);
          const iso = await isolationModule();
          let applied: string[];
          try {
            ({ applied } = await iso.apply(ws));
          } catch (e) {
            throw new Error(`${(e as Error).message}. Worktree kept at ${ws.path} (branch ${ws.branch}); nothing was changed in your tree.`);
          }
          forget(p.id!);
          let left = "";
          try {
            await iso.discard(ws, { force: true }); // safe: the changes now live in the parent tree
          } catch (e) {
            left = `\nworktree cleanup incomplete: ${(e as Error).message}`;
          }
          return text(`applied ${applied.length} file(s):\n${applied.join("\n")}${left}`);
        }
        case "discard": {
          need("id");
          const ws = workspaceOf(p.id!);
          await (await isolationModule()).discard(ws, { force: true });
          forget(p.id!);
          return text(`discarded ${p.id}`);
        }
        case "inbox":
          return text(inbox.size ? inbox.format(inbox.drain()) : "no finished jobs pending");
      }
    },
  });

  pi.registerCommand("subagents", {
    description: "Show subagent jobs",
    handler: async (_args, c) => {
      const jobs = state?.jobs.list() ?? [];
      c.ui.notify([...interrupted, ...jobs].map(line).join("\n") || "no jobs", "info");
    },
  });

  /** Show results that finished unread before the last shutdown, once, without waking the agent. */
  async function surfaceUnread(c: ExtensionContext) {
    const unread = new Map<string, JobRecord>();
    for (const e of c.sessionManager.getBranch()) {
      if (e.type !== "custom" || e.customType !== UNREAD_ENTRY) continue;
      const d = (e as { data: { records?: JobRecord[]; ack?: string[] } }).data;
      for (const r of d.records ?? []) unread.set(r.id, r);
      for (const id of d.ack ?? []) unread.delete(id);
    }
    if (!unread.size) return;
    const records = [...unread.values()];
    const { createInbox } = await import("./inbox.ts");
    pi.sendMessage(
      { customType: "subagent-results", content: `Unread results from before the restart:\n\n${createInbox().format(records)}`, display: true },
      { triggerTurn: false },
    );
    pi.appendEntry(UNREAD_ENTRY, { ack: records.map((r) => r.id) });
  }

  pi.on("session_start", async (_e, c) => {
    ctx = c;
    const seen = c.sessionManager.getBranch()
      .filter((e) => e.type === "custom" && e.customType === JOB_ENTRY)
      .map((e) => (e as { data: JobRecord }).data);
    workspaces.clear();
    for (const e of c.sessionManager.getBranch()) {
      if (e.type !== "custom" || e.customType !== WS_ENTRY) continue;
      const d = (e as { data: { jobId: string; ws?: Workspace; discarded?: boolean } }).data;
      if (d.discarded) workspaces.delete(d.jobId);
      else if (d.ws) workspaces.set(d.jobId, d.ws);
    }
    await surfaceUnread(c);
    if (!seen.length) return;
    const { restoreInterrupted } = await import("./jobs.ts");
    interrupted = restoreInterrupted(seen).filter((r) => r.state === "interrupted" && !seen.some((s) => s.id === r.id && s.state === "interrupted"));
    for (const r of interrupted) pi.appendEntry(JOB_ENTRY, r);
    if (interrupted.length)
      pi.sendMessage(
        { customType: "subagent-interrupted", content: `Interrupted by restart, not resumed:\n${interrupted.map(line).join("\n")}`, display: true },
        { triggerTurn: false },
      );
  });
  pi.on("agent_start", () => {
    waking = false;
  });
  pi.on("agent_settled", (e, c) => {
    ctx = c;
    waking = false;
    flushIfIdle(!e.aborted); // after a user abort, deliver passively instead of restarting the agent
  });
  pi.on("session_shutdown", async () => {
    ctx = undefined;
    const s = await pending?.catch(() => undefined);
    await s?.jobs.shutdown();
    const unread = s ? s.inbox.drain().filter(isDone) : []; // shutdown-cancelled jobs are noise; real results are kept
    if (unread.length) pi.appendEntry(UNREAD_ENTRY, { records: unread });
    pending = state = undefined;
  });
}
