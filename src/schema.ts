/** The model-facing tool contract: schema, parameter types, and the short strings tool results share. */
import type { JobRecord } from "./jobs.ts";

export const ACTIONS = ["start", "list", "status", "steer", "cancel", "agents", "inbox", "diff", "apply", "discard"] as const;
export type Action = (typeof ACTIONS)[number];

type ArgKey = "agent" | "task" | "id" | "message";

/** Arguments each action cannot run without. */
const REQUIRED: Record<Action, readonly ArgKey[]> = {
  start: ["agent", "task"],
  list: [],
  status: ["id"],
  steer: ["id", "message"],
  cancel: ["id"],
  agents: [],
  inbox: [],
  diff: ["id"],
  apply: ["id"],
  discard: ["id"],
};

export interface Params {
  action: Action;
  agent?: string;
  task?: string;
  id?: string;
  message?: string;
  wait?: boolean;
  isolate?: boolean;
}

/** Plain JSON Schema: avoids loading typebox and pi-ai at startup. The cast is the one escape hatch to Pi's TypeBox-typed API. */
export const params = {
  type: "object",
  properties: {
    action: { type: "string", enum: ACTIONS },
    agent: { type: "string" },
    task: {
      type: "string",
      description: "Self-contained brief; no parent conversation is passed (project AGENTS.md/CLAUDE.md still load)",
    },
    id: { type: "string" },
    message: { type: "string" },
    wait: { type: "boolean", description: "Block until finished (default: background)" },
    isolate: { type: "boolean", description: "Run in a git worktree; review with diff, then apply or discard" },
  },
  required: ["action"],
} as never;

export function requireArgs(p: Params): void {
  const missing = REQUIRED[p.action].filter((k) => !p[k]);
  if (missing.length) throw new Error(`${p.action} requires ${missing.join(", ")}`);
}

export const WAIT_HINT =
  "Results are delivered automatically when jobs finish. End your turn now; do not poll, sleep, or call list/status/inbox.";
export const MAX_DIFF_CHARS = 6000;

export const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
export const isDone = (r: JobRecord) => r.state === "completed" || r.state === "failed";
export const line = (r: JobRecord) =>
  `${r.id} ${r.agent} ${r.state}${r.delivered ? "" : r.result ? " (unread)" : ""}: ${r.task.slice(0, 60)}`;
