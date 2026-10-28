import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createInbox, type Inbox } from "./inbox.ts";
import { createJobs, isWriter, restoreInterrupted, type JobRecord, type Jobs } from "./jobs.ts";
import type { Runner } from "./types.ts";

const TIMEOUT_MS = 30 * 60_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const JOB_ENTRY = "subagent-job";

const params = Type.Object({
  action: StringEnum(["start", "list", "status", "steer", "cancel", "agents", "inbox"] as const),
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String({ description: "Self-contained brief; the agent sees nothing else" })),
  id: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  wait: Type.Optional(Type.Boolean({ description: "Block until finished (default: background)" })),
});

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
let agentsMod: Promise<typeof import("./agents.ts")> | undefined;
/** One shared import: Pi's loader hands concurrent first imports a half-initialised module. */
const agentsModule = () => (agentsMod ??= import("./agents.ts"));
const line = (r: JobRecord) => `${r.id} ${r.agent} ${r.state}${r.delivered ? "" : r.result ? " (unread)" : ""}: ${r.task.slice(0, 60)}`;

export default function (pi: ExtensionAPI, injected?: Runner) {
  let ctx: ExtensionContext | undefined;
  let state: { jobs: Jobs; inbox: Inbox } | undefined;
  let pending: Promise<{ jobs: Jobs; inbox: Inbox }> | undefined; // parallel first calls must share one state
  let interrupted: JobRecord[] = [];

  /** Wake the orchestrator with everything finished and unread, once. */
  function flush() {
    if (!state || state.inbox.size === 0) return;
    const records = state.inbox.drain();
    pi.sendMessage({ customType: "subagent-results", content: state.inbox.format(records), display: true }, { triggerTurn: true });
  }
  const flushIfIdle = () => {
    try {
      if (ctx?.isIdle()) flush();
    } catch {
      ctx = undefined; // stale after reload; session_start recaptures
    }
  };

  function getState() {
    return (pending ??= build());
  }
  async function build() {
    const runner = injected ?? (await import("./runner.ts")).createRunner();
    const inbox = createInbox({ onPublish: flushIfIdle });
    const jobs = createJobs({
      runner,
      onTerminal: (r) => inbox.publish(r),
      onChange: ({ id, agent, task, state: s, createdAt, endedAt, delivered }) =>
        pi.appendEntry(JOB_ENTRY, { id, agent, task, state: s, createdAt, endedAt, delivered }),
    });
    return (state = { jobs, inbox });
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate tasks to independent agents. action=agents lists them; start runs one (background unless wait).",
    parameters: params,
    async execute(_id, p, signal, _onUpdate, c) {
      const need = (...k: ("agent" | "task" | "id" | "message")[]) => {
        const missing = k.filter((x) => !p[x]);
        if (missing.length) throw new Error(`${p.action} requires ${missing.join(", ")}`);
      };
      const { jobs, inbox } = await getState();
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
          const rec = jobs.start({
            agent: def.name,
            writes: isWriter(def.tools),
            repoKey: c.cwd,
            spec: {
              cwd: c.cwd,
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
          if (!p.wait) return text(`started ${rec.id} (${def.name})`);
          const onAbort = () => void jobs.cancel(rec.id);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
          try {
            await jobs.wait(rec.id);
          } finally {
            signal?.removeEventListener("abort", onAbort);
          }
          const done = inbox.take(rec.id);
          const out = done ? inbox.format([done]) : line(rec);
          if (rec.state === "failed") throw new Error(out);
          return text(out);
        }
        case "list":
          return text([...interrupted, ...jobs.list()].map(line).join("\n") || "no jobs");
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
          return text(`${r.id} ${r.state}`);
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

  pi.on("session_start", (_e, c) => {
    ctx = c;
    const seen = c.sessionManager.getBranch()
      .filter((e) => e.type === "custom" && e.customType === JOB_ENTRY)
      .map((e) => (e as { data: JobRecord }).data);
    interrupted = restoreInterrupted(seen).filter((r) => r.state === "interrupted" && !seen.some((s) => s.id === r.id && s.state === "interrupted"));
    for (const r of interrupted) pi.appendEntry(JOB_ENTRY, r);
    if (interrupted.length)
      pi.sendMessage(
        { customType: "subagent-interrupted", content: `Interrupted by restart, not resumed:\n${interrupted.map(line).join("\n")}`, display: true },
        { triggerTurn: false },
      );
  });
  pi.on("agent_settled", (_e, c) => {
    ctx = c;
    flushIfIdle();
  });
  pi.on("session_shutdown", async () => {
    ctx = undefined;
    const s = await pending?.catch(() => undefined);
    pending = undefined;
    await s?.jobs.shutdown();
    state = undefined;
  });
}
