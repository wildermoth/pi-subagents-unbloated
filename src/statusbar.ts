/** The live job widget as plain functions: records in, styled lines out. No Pi imports, so it is easy to test. */
import type { JobRecord } from "./jobs.ts";
import type { Progress } from "./types.ts";

export const MAX_ROWS = 5;
export const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Style {
  accent: (s: string) => string;
  dim: (s: string) => string;
  success: (s: string) => string;
  warn: (s: string) => string;
  error: (s: string) => string;
  bold: (s: string) => string;
}
export const plain: Style = { accent: (s) => s, dim: (s) => s, success: (s) => s, warn: (s) => s, error: (s) => s, bold: (s) => s };

/** One display line of text: whitespace collapsed, clipped with an ellipsis. */
export function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function elapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
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
  /** Id of the job the list cursor is on, marked with an arrow. */
  selected?: string;
  /** Show the key hints under the list (the list is active). */
  hint?: boolean;
  /** Cuts a styled line to the terminal width (ANSI and wide-character aware in production). */
  fit(this: void, line: string, width: number): string;
  /** Visible terminal columns, ignoring ANSI styling. */
  measure?(this: void, line: string): number;
}

export function tokens(n: number): string {
  return n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`;
}

/** What a tool call is doing, and what one of them is called when several run at once. */
const TOOLS: Record<string, [verb: string, noun: string]> = {
  read: ["reading", "file"],
  edit: ["editing", "file"],
  write: ["writing", "file"],
  grep: ["searching", "pattern"],
  find: ["searching", "pattern"],
  ls: ["listing", "dir"],
  bash: ["running", "command"],
};

/** "editing 2 files…", or the end of what it is saying when no tool is running, or "thinking…". */
export function activity(p: Progress | undefined): string {
  const counts = new Map<string, number>();
  for (const name of p?.active ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
  if (counts.size)
    return `${[...counts]
      .map(([name, n]) => {
        const [verb, noun] = TOOLS[name] ?? [`using ${name}`, "call"];
        return n > 1 ? `${verb} ${n} ${noun}s` : verb;
      })
      .join(", ")}…`;
  // The end of the latest line, so the row keeps moving while text streams in.
  const flat = clip(p?.text.split("\n").findLast((l) => l.trim()) ?? "", Infinity);
  return flat.length > 60 ? `…${flat.slice(-59)}` : flat || "thinking…";
}

const icon = (r: JobRecord, frame: number, s: Style): string =>
  isRunning(r)
    ? s.accent(FRAMES[frame % FRAMES.length]!)
    : r.state === "completed"
      ? s.success("✓")
      : r.state === "failed"
        ? s.error("✗")
        : s.dim("■");

/** Compact telemetry stays on the right; activity gets the remaining columns. */
function stats(r: JobRecord, now: number, s: Style): string {
  const p = r.progress;
  const pct = p && r.contextWindow ? Math.round((p.tokens / r.contextWindow) * 100) : 0;
  const pctStyle = pct >= 85 ? s.error : pct >= 70 ? s.warn : s.dim;
  const context = isRunning(r) && pct ? s.dim(" (") + pctStyle(`${pct}%`) + s.dim(")") : "";
  return s.dim(`${elapsed((r.endedAt ?? now) - (r.startedAt ?? r.createdAt))} · ↓ ${tokens(p?.tokens ?? 0)} tokens`) + context;
}

/** A single row, with telemetry right-aligned without clipping it behind a long task. */
function row(r: JobRecord, o: RenderOptions): string {
  const { style: s, frame, now, width, fit } = o;
  const measure = o.measure ?? ((line: string) => [...line].length);
  const detail = isRunning(r)
    ? activity(r.progress)
    : r.result?.status === "failed"
      ? `error: ${clip(r.result.failure.message, 120)}`
      : clip(r.result?.text.trim() ? r.result.text : r.task, 120);
  const prefix = `${r.id === o.selected ? s.accent("❯") : " "} ${icon(r, frame, s)} ${s.bold(r.agent)}  `;
  const right = stats(r, now, s);
  // On very narrow terminals preserve the agent identity instead of showing only telemetry.
  if (measure(prefix) + measure(right) + 3 > width) return fit(prefix + s.dim(detail), width);
  const left = prefix + fit(s.dim(detail), Math.max(0, width - measure(prefix) - measure(right) - 2));
  return left + " ".repeat(Math.max(2, width - measure(left) - measure(right))) + right;
}

/** The jobs the cursor can move over: exactly the rows the widget draws. */
export const selectable = (records: readonly JobRecord[]): JobRecord[] => select(records).shown.slice(0, MAX_ROWS);

/** A compact strip below the editor, or undefined when there is nothing to show. */
export function renderStatus(records: readonly JobRecord[], o: RenderOptions): string[] | undefined {
  const { shown, queued } = select(records);
  if (!shown.length && !queued) return undefined;
  const { style: s } = o;
  const lines = [
    s.dim(o.hint ? "  ↑/↓ select · enter actions · esc return" : `  ← ${shown.length + queued} agents · ↓ to manage`),
    `  ${s.success("●")} ${s.bold("main")}`,
    ...shown.slice(0, MAX_ROWS).map((r) => row(r, o)),
  ];
  const more = [shown.length > MAX_ROWS && `+${shown.length - MAX_ROWS} more`, queued > 0 && `${queued} queued`].filter(Boolean).join(", ");
  if (more) lines.push(s.dim(`  ${more}`));
  return lines.map((l) => o.fit(l, o.width));
}
