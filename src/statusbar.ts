/** The live job widget as plain functions: records in, styled lines out. No Pi imports, so it is easy to test. */
import type { JobRecord } from "./jobs.ts";

export const MAX_ROWS = 5;
export const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Style {
  accent(s: string): string;
  dim(s: string): string;
  success(s: string): string;
  error(s: string): string;
  bold(s: string): string;
}
export const plain: Style = { accent: (s) => s, dim: (s) => s, success: (s) => s, error: (s) => s, bold: (s) => s };

/** One display line of text: whitespace collapsed, clipped with an ellipsis. */
export function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function elapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

const isRunning = (r: JobRecord) => r.state === "starting" || r.state === "running";
const isUnread = (r: JobRecord) => (r.state === "completed" || r.state === "failed" || r.state === "cancelled") && !r.delivered;

/** What the widget shows: running jobs, finished jobs the model has not read, and counts of queued and running ones. */
export function select(records: readonly JobRecord[]) {
  const running = records.filter(isRunning);
  return {
    shown: [...running, ...records.filter(isUnread)],
    queued: records.filter((r) => r.state === "queued").length,
    running: running.length,
  };
}

export interface RenderOptions {
  now: number;
  frame: number;
  width: number;
  style: Style;
  /** Cuts a styled line to the terminal width (ANSI and wide-character aware in production). */
  fit(line: string, width: number): string;
}

/** A job's header line, and for running jobs a second line with its latest output. */
function row(r: JobRecord, { now, frame, style: s }: RenderOptions): { head: string; sub?: string } {
  const icon = isRunning(r)
    ? s.accent(FRAMES[frame % FRAMES.length]!)
    : r.state === "completed"
      ? s.success("✓")
      : r.state === "failed"
        ? s.error("✗")
        : s.dim("■");
  const time = elapsed((r.endedAt ?? now) - (r.startedAt ?? r.createdAt));
  const failure = r.result?.status === "failed" ? ` ${s.error(`error: ${clip(r.result.failure.message, 60)}`)}` : "";
  return {
    head: `${icon} ${s.bold(r.agent)}  ${s.dim(`${clip(r.task, 60)} · ${time}`)}${failure}`,
    sub: isRunning(r) && r.activity ? s.dim(`⎿  ${clip(r.activity, 80)}`) : undefined,
  };
}

/** Tree-drawn lines, or undefined when there is nothing to show (clear the widget). */
export function renderStatus(records: readonly JobRecord[], o: RenderOptions): string[] | undefined {
  const { shown, queued } = select(records);
  if (!shown.length && !queued) return undefined;
  const rows = shown.slice(0, MAX_ROWS).map((r) => row(r, o));
  const more = [shown.length > MAX_ROWS && `+${shown.length - MAX_ROWS} more`, queued > 0 && `${queued} queued`].filter(Boolean).join(", ");
  if (more) rows.push({ head: o.style.dim(`◦ ${more}`) });
  const live = shown.some(isRunning) || queued > 0;
  const lines = [`${live ? o.style.accent("●") : o.style.dim("○")} ${o.style.bold("Agents")}`];
  rows.forEach(({ head, sub }, i) => {
    const last = i === rows.length - 1;
    lines.push(`${last ? "└─" : "├─"} ${head}`);
    if (sub) lines.push(`${last ? "   " : "│  "}    ${sub}`);
  });
  return lines.map((l) => o.fit(l, o.width));
}
