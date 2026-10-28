import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Inbox } from "./inbox.ts";
import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { JobRecord, Jobs } from "./jobs.ts";
import type { Workspace } from "./isolation.ts";
import { createWidget } from "./widget.ts";
import { recover, JOB_ENTRY, UNREAD_ENTRY, WS_ENTRY } from "./recovery.ts";
import { isDone, line, MAX_DIFF_CHARS, params, requireArgs, text, WAIT_HINT, type Params } from "./schema.ts";
import type { Runner } from "./types.ts";

const TIMEOUT_MS = 30 * 60_000;
const LAUNCH_TIMEOUT_MS = 30_000;

let agentsMod: Promise<typeof import("./agents.ts")> | undefined;
/** One shared import: Pi's loader hands concurrent first imports a half-initialised module. */
const agentsModule = () => (agentsMod ??= import("./agents.ts"));
let isoMod: Promise<typeof import("./isolation.ts")> | undefined;
const isolationModule = () => (isoMod ??= import("./isolation.ts"));
/** Both backends behind one Runner: the spec says which. Each loads only when first used. */
async function backends(): Promise<Runner> {
  const [{ createRunner }, { createSdkRunner }] = await Promise.all([import("./runner.ts"), import("./sdk-runner.ts")]);
  const rpc = createRunner();
  const sdk = createSdkRunner();
  return { start: (spec) => (spec.inprocess ? sdk : rpc).start(spec) };
}

export default function (pi: ExtensionAPI, injected?: Runner) {
  let ctx: ExtensionContext | undefined;
  let state: { jobs: Jobs; inbox: Inbox } | undefined;
  let pending: ReturnType<typeof build> | undefined; // parallel first calls must share one state
  let interrupted: JobRecord[] = [];
  const workspaces = new Map<string, Workspace>(); // job id -> isolated worktree, kept until apply or discard

  let agentSection: Promise<string> | undefined; // cached for the session; reset at session_start

  const widget = createWidget(() => state?.jobs.list() ?? []);
  let waking = false; // a wake is in flight; sendMessage defers inside agent_settled, so isIdle() stays true meanwhile

  /** The job's worktree, refusing while the job could still be writing to it. */
  function workspaceOf(id: string): Workspace {
    const ws = workspaces.get(id);
    if (!ws) throw new Error(`job ${id} has no isolated worktree`);
    const r = state?.jobs.get(id);
    if (r && !["completed", "failed", "cancelled"].includes(r.state))
      throw new Error(`job ${id} is still ${r.state}; wait or cancel first`);
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
      widget.update();
    } catch (e) {
      inbox.requeue(records); // never lose a result to a failed send
      throw e;
    }
  }
  const flushIfIdle = (wake = true) => {
    let idle: boolean;
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
    const [{ createInbox }, { createJobs }, runner] = await Promise.all([
      import("./inbox.ts"),
      import("./jobs.ts"),
      injected ?? backends(),
    ]);
    const inbox = createInbox({ onPublish: flushIfIdle });
    const jobs = createJobs({
      runner,
      onTerminal: (r) => inbox.publish(r),
      onChange: ({ id, agent, task, state: s, createdAt, endedAt, delivered }) => {
        pi.appendEntry(JOB_ENTRY, { id, agent, task, state: s, createdAt, endedAt, delivered });
        widget.update();
      },
      onProgress: widget.touch,
    });
    return (state = { jobs, inbox });
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate to agents: start needs agent and task, runs in background. Then end your turn.",
    parameters: params,
    async execute(_id, args, signal, _onUpdate, c) {
      try {
        return await runAction(args, signal, c);
      } finally {
        widget.update(); // reads and cancels change what is still unread
      }
    },
  });

  async function runAction(args: unknown, signal: AbortSignal | undefined, c: ExtensionContext) {
    const p = args as Params;
    const agentList = async () => {
      const { discoverAgents, listAgents } = await agentsModule();
      const { agents, warnings } = await discoverAgents({ cwd: c.cwd, projectTrusted: c.isProjectTrusted() });
      return [listAgents(agents), ...warnings].filter(Boolean).join("\n") || "no agents defined";
    };
    try {
      requireArgs(p);
    } catch (e) {
      // A model that guessed at start without an agent name gets the names in the error, not a second round trip.
      if (p.action === "start" && !p.agent)
        throw new Error(`${(e as Error).message}. Available agents:\n${await agentList()}`, { cause: e });
      throw e;
    }
    const { jobs, inbox } = await getState();
    switch (p.action) {
      case "agents":
        return text(await agentList());
      case "start": {
        const { discoverAgents, resolveAgent, splitModel } = await agentsModule();
        const { agents } = await discoverAgents({ cwd: c.cwd, projectTrusted: c.isProjectTrusted() });
        const def = resolveAgent(agents, p.agent!);
        let cwd = c.cwd;
        let ws: Workspace | undefined;
        // Git isolation is opt-in; without it agents share the working tree. Resolve only then.
        if (p.isolate) {
          cwd = await realpath(c.cwd);
          const iso = await isolationModule();
          const root = await iso.repoRootOf(cwd);
          ws = await iso.create({ repoRoot: root, id: crypto.randomUUID().slice(0, 12) });
          cwd = join(ws.path, relative(root, cwd)); // root is canonical, so cwd must be too (macOS /var, Windows 8.3 names)
        }
        let rec: JobRecord;
        try {
          rec = jobs.start({
            agent: def.name,
            spec: {
              cwd,
              task: p.task!,
              inprocess: def.inprocess,
              systemPrompt: def.prompt,
              tools: def.tools,
              model: def.model ?? (c.model ? `${c.model.provider}/${c.model.id}` : undefined),
              thinking: def.thinking ?? c.thinkingLevel,
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
        const ref = def.model ? splitModel(def.model) : undefined;
        rec.contextWindow = (ref ? c.modelRegistry.find(ref.provider, ref.id) : c.model)?.contextWindow;
        if (ws) {
          workspaces.set(rec.id, ws);
          rec.note = `worktree kept: diff ${rec.id}, then apply or discard ${rec.id}`;
          pi.appendEntry(WS_ENTRY, { jobId: rec.id, ws });
        }
        if (!p.wait) return text(`started ${rec.id} (${def.name}). Do not poll; results arrive on their own.`);
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
      case "list": {
        const all = [...interrupted, ...jobs.list()];
        const out = all.map((r) => line(r) + (workspaces.has(r.id) ? " [worktree]" : "")).join("\n") || "no jobs";
        return text(all.some((r) => !isDone(r) && r.state !== "cancelled" && r.state !== "interrupted") ? `${out}\n${WAIT_HINT}` : out);
      }
      case "status": {
        const r = jobs.get(p.id!) ?? interrupted.find((j) => j.id === p.id);
        if (!r) throw new Error(`unknown job ${p.id}`);
        const done = inbox.take(r.id); // reading output consumes it, so no later wakeup repeats it
        return text(
          done
            ? inbox.format([done])
            : isDone(r) || r.state === "cancelled" || r.state === "interrupted"
              ? line(r)
              : `${line(r)}\n${WAIT_HINT}`,
        );
      }
      case "steer":
        await jobs.steer(p.id!, p.message!);
        return text(`steered ${p.id}`);
      case "cancel": {
        const r = await jobs.cancel(p.id!);
        inbox.take(r.id); // the caller is told here, a later wakeup would repeat it
        return text(`${r.id} ${r.state}`);
      }
      case "diff": {
        const { changed, diff, clean } = await (await isolationModule()).inspect(workspaceOf(p.id!));
        if (clean) return text("no changes");
        const head = `${changed.length} changed:\n${changed.slice(0, 50).join("\n")}`;
        const more = diff.length > MAX_DIFF_CHARS ? `\n[diff truncated, ${diff.length - MAX_DIFF_CHARS} more characters]` : "";
        return text(`${head}\n\n${diff.slice(0, MAX_DIFF_CHARS)}${more}`);
      }
      case "apply": {
        const ws = workspaceOf(p.id!);
        const iso = await isolationModule();
        let applied: string[];
        try {
          ({ applied } = await iso.apply(ws));
        } catch (e) {
          throw new Error(`${(e as Error).message}. Worktree kept at ${ws.path} (branch ${ws.branch}); nothing was changed in your tree.`, {
            cause: e,
          });
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
        const ws = workspaceOf(p.id!);
        await (await isolationModule()).discard(ws, { force: true });
        forget(p.id!);
        return text(`discarded ${p.id}`);
      }
      case "inbox":
        return text(inbox.size ? inbox.format(inbox.drain()) : `no finished jobs pending. ${WAIT_HINT}`);
    }
  }

  pi.registerCommand("subagent-model", {
    description: "Choose an agent's model and thinking level",
    handler: async (_args, c) => {
      const { discoverAgents } = await agentsModule();
      const { agents } = await discoverAgents({ cwd: c.cwd, projectTrusted: c.isProjectTrusted() });
      if (!agents.size) return c.ui.notify("no agents defined", "info");
      const { configureAgent } = await import("./agent-config.ts");
      await configureAgent(c, [...agents.values()]);
    },
  });

  pi.registerCommand("subagents", {
    description: "Show subagent jobs",
    handler: (_args, c) => {
      const jobs = state?.jobs.list() ?? [];
      c.ui.notify([...interrupted, ...jobs].map(line).join("\n") || "no jobs", "info");
      return Promise.resolve();
    },
  });

  /** Show results that finished unread before the last shutdown, once, without waking the agent. */
  async function surfaceUnread(records: JobRecord[]) {
    if (!records.length) return;
    const { createInbox } = await import("./inbox.ts");
    pi.sendMessage(
      {
        customType: "subagent-results",
        content: `Unread results from before the restart:\n\n${createInbox().format(records)}`,
        display: true,
      },
      { triggerTurn: false },
    );
    pi.appendEntry(UNREAD_ENTRY, { ack: records.map((r) => r.id) });
  }

  pi.on("session_start", async (_e, c) => {
    ctx = c;
    widget.bind(c.mode === "tui" ? c.ui : undefined);
    agentSection = undefined;
    const { jobs: seen, workspaces: restored, unread } = recover(c.sessionManager.getBranch());
    workspaces.clear();
    for (const [id, ws] of restored) workspaces.set(id, ws);
    await surfaceUnread(unread);
    interrupted = [];
    if (!seen.length) return;
    const { restoreInterrupted } = await import("./jobs.ts");
    interrupted = restoreInterrupted(seen).filter((r) => r.state === "interrupted");
    const reported = new Set(seen.filter((r) => r.state === "interrupted").map((r) => r.id));
    const fresh = interrupted.filter((r) => !reported.has(r.id));
    for (const r of fresh) pi.appendEntry(JOB_ENTRY, r);
    if (fresh.length)
      pi.sendMessage(
        {
          customType: "subagent-interrupted",
          content: `Interrupted by restart, not resumed:\n${fresh.map(line).join("\n")}`,
          display: true,
        },
        { triggerTurn: false },
      );
  });
  /** Names and short blurbs go into the system prompt once per session, so the model can start agents without an `agents` call. */
  pi.on("before_agent_start", async (e, c) => {
    if (!e.systemPromptOptions.selectedTools.includes("subagent")) return;
    try {
      // One discovery per session keeps the prompt prefix stable (cache friendly); `agents` still reads live.
      agentSection ??= (async () => {
        const { discoverAgents, briefAgents } = await agentsModule();
        const { agents } = await discoverAgents({ cwd: c.cwd, projectTrusted: c.isProjectTrusted() });
        return agents.size ? `Agents for the subagent tool (agent=<name>):\n${briefAgents(agents)}` : "";
      })();
      const section = await agentSection;
      if (section) e.systemPromptOptions.sections.subagents = section;
    } catch {
      agentSection = undefined; // discovery failed; the model can still call `agents`
    }
  });
  pi.on("agent_start", () => {
    waking = false;
  });
  pi.on("agent_settled", (e, c) => {
    ctx = c;
    widget.bind(c.mode === "tui" ? c.ui : undefined); // custom components only exist in the terminal UI
    waking = false;
    flushIfIdle(!e.aborted); // after a user abort, deliver passively instead of restarting the agent
  });
  pi.on("session_shutdown", async () => {
    widget.dispose();
    ctx = undefined;
    const s = await pending?.catch(() => undefined);
    await s?.jobs.shutdown();
    const unread = s ? s.inbox.drain().filter(isDone) : []; // shutdown-cancelled jobs are noise; real results are kept
    if (unread.length) pi.appendEntry(UNREAD_ENTRY, { records: unread });
    pending = state = undefined;
  });
}
