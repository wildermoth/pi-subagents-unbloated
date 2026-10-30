/** Rebuilds subagent state from the Pi session entries persisted by index.ts. One pass over the branch. */
import type { Workspace } from "./isolation.ts";
import type { JobRecord } from "./jobs.ts";

export const JOB_ENTRY = "subagent-job";
export const WS_ENTRY = "subagent-workspace";
export const UNREAD_ENTRY = "subagent-unread"; // results finished but never read when the session ended

interface Entry {
  type: string;
  customType?: string;
  data?: unknown;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalType(value: unknown, type: "string" | "number" | "boolean"): boolean {
  return value === undefined || typeof value === type;
}

function result(value: unknown): boolean {
  if (value === undefined) return true;
  if (!object(value) || typeof value.text !== "string" || typeof value.truncated !== "boolean") return false;
  if (value.status !== "failed") return (value.status === "completed" || value.status === "cancelled") && value.failure === undefined;
  const failure = value.failure;
  return (
    object(failure) &&
    typeof failure.kind === "string" &&
    ["launch", "protocol", "exit", "timeout", "provider", "rejected"].includes(failure.kind) &&
    typeof failure.message === "string"
  );
}

function progress(value: unknown): boolean {
  return (
    value === undefined ||
    (object(value) &&
      typeof value.turns === "number" &&
      typeof value.tools === "number" &&
      typeof value.tokens === "number" &&
      typeof value.text === "string" &&
      Array.isArray(value.active) &&
      value.active.every((item: unknown) => typeof item === "string"))
  );
}

function job(value: unknown): value is JobRecord {
  return (
    object(value) &&
    typeof value.id === "string" &&
    typeof value.agent === "string" &&
    typeof value.task === "string" &&
    typeof value.state === "string" &&
    ["queued", "starting", "running", "completed", "failed", "cancelled", "interrupted"].includes(value.state) &&
    typeof value.createdAt === "number" &&
    typeof value.delivered === "boolean" &&
    optionalType(value.startedAt, "number") &&
    optionalType(value.endedAt, "number") &&
    optionalType(value.contextWindow, "number") &&
    optionalType(value.note, "string") &&
    result(value.result) &&
    progress(value.progress)
  );
}

function workspace(value: unknown): value is Workspace {
  return (
    object(value) &&
    typeof value.id === "string" &&
    typeof value.repoRoot === "string" &&
    typeof value.path === "string" &&
    typeof value.branch === "string" &&
    typeof value.baseCommit === "string"
  );
}

function updateUnread(value: unknown, unread: Map<string, JobRecord>): void {
  if (!object(value)) return;
  if (Array.isArray(value.records)) for (const record of value.records) if (job(record)) unread.set(record.id, record);
  if (Array.isArray(value.ack)) for (const id of value.ack) if (typeof id === "string") unread.delete(id);
}

export interface Recovered {
  /** Every persisted job record, oldest first, repeats included. */
  jobs: JobRecord[];
  /** Isolated worktrees not yet applied or discarded, by job id. */
  workspaces: Map<string, Workspace>;
  /** Finished results that were never read before shutdown. */
  unread: JobRecord[];
}

export function recover(branch: readonly Entry[]): Recovered {
  const jobs: JobRecord[] = [];
  const workspaces = new Map<string, Workspace>();
  const unread = new Map<string, JobRecord>();
  for (const e of branch) {
    if (e.type !== "custom") continue;
    switch (e.customType) {
      case JOB_ENTRY:
        if (job(e.data)) jobs.push(e.data);
        break;
      case WS_ENTRY: {
        const d = e.data;
        if (!object(d) || typeof d.jobId !== "string") break;
        if (d.discarded === true) workspaces.delete(d.jobId);
        else if (workspace(d.ws)) workspaces.set(d.jobId, d.ws);
        break;
      }
      case UNREAD_ENTRY:
        updateUnread(e.data, unread);
        break;
      default:
        break;
    }
  }
  return { jobs, workspaces, unread: [...unread.values()] };
}
