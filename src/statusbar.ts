/** Compact live view of subagent jobs for the Pi widget area. Pure: no Pi imports, easy to test. */
import type { JobRecord } from "./jobs.ts";

export const MAX_LINES = 5;
export const TEXT_CHARS = 80;

const LIVE = new Set<JobRecord["state"]>(["queued", "starting", "running"]);
const FINISHED = new Set<JobRecord["state"]>(["completed", "failed", "cancelled"]);

/** One line of display text: whitespace collapsed, clipped with an ellipsis. */
export function clip(s: string, max = TEXT_CHARS): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Live jobs plus finished ones the model has not read yet; hidden once delivered. Undefined clears the widget. */
export function renderStatus(records: readonly JobRecord[], max = MAX_LINES): string[] | undefined {
  const visible = [...records.filter((r) => LIVE.has(r.state)), ...records.filter((r) => FINISHED.has(r.state) && !r.delivered)];
  if (!visible.length) return undefined;
  const lines = visible.slice(0, max).map((r) => {
    const last = r.activity ?? (r.result?.status === "failed" ? r.result.failure.message : r.result?.text) ?? r.task;
    return `${r.state} | ${r.agent}: ${clip(last)}`;
  });
  if (visible.length > max) lines.push(`+${visible.length - max} more`);
  return lines;
}
