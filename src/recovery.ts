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
        jobs.push(e.data as JobRecord);
        break;
      case WS_ENTRY: {
        const d = e.data as { jobId: string; ws?: Workspace; discarded?: boolean };
        if (d.discarded) workspaces.delete(d.jobId);
        else if (d.ws) workspaces.set(d.jobId, d.ws);
        break;
      }
      case UNREAD_ENTRY: {
        const d = e.data as { records?: JobRecord[]; ack?: string[] };
        for (const r of d.records ?? []) unread.set(r.id, r);
        for (const id of d.ack ?? []) unread.delete(id);
        break;
      }
    }
  }
  return { jobs, workspaces, unread: [...unread.values()] };
}
