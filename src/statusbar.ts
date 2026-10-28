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
  /** Cuts a styled line to the terminal width (ANSI and wide-character aware in production). */
  fit(line: string, width: number): string;
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
  web_search: ["searching the web", "query"],
  web_fetch: ["fetching", "page"],
};

/** "editing 2 files…", or what it last said when no tool is running, or "thinking…". */
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
  const said = clip(p?.text.split("\n").find((l) => l.trim()) ?? "", 60);
  return said ? `${said}${(p?.text.length ?? 0) > said.length ? "…" : ""}` : "thinking…";
}

const icon = (r: JobRecord, frame: number, s: Style): string =>
  isRunning(r)
    ? s.accent(FRAMES[frame % FRAMES.length]!)
    : r.state === "completed"
      ? s.success("✓")
      : r.state === "failed"
        ? s.error("✗")
        : s.dim("■");

/** "↻5 · 5 tool uses · 33.8k token (62%) · 12.3s", leaving out what is still zero. */
function stats(r: JobRecord, now: number, s: Style): string {
  const p = r.progress;
  const pct = p && r.contextWindow ? Math.round((p.tokens / r.contextWindow) * 100) : 0;
  const pctStyle = pct >= 85 ? s.error : pct >= 70 ? s.warn : s.dim;
  const context = isRunning(r) && pct ? s.dim(" (") + pctStyle(`${pct}%`) + s.dim(")") : "";
  return [
    p?.turns ? s.dim(`↻${p.turns}`) : "",
    p?.tools ? s.dim(`${p.tools} tool use${p.tools > 1 ? "s" : ""}`) : "",
    p?.tokens ? s.dim(`${tokens(p.tokens)} token`) + context : "",
    s.dim(elapsed((r.endedAt ?? now) - (r.startedAt ?? r.createdAt))),
  ]
    .filter(Boolean)
    .join(s.dim(" · "));
}

/** A job's header line, and for running jobs a second line with what it is doing. */
function row(r: JobRecord, { now, frame, style: s }: RenderOptions): { head: string; sub?: string } {
  const failure = r.result?.status === "failed" ? ` ${s.error(`error: ${clip(r.result.failure.message, 60)}`)}` : "";
  return {
    head: `${icon(r, frame, s)} ${s.bold(r.agent)}  ${s.dim(clip(r.task, 60))} ${s.dim("·")} ${stats(r, now, s)}${failure}`,
    sub: isRunning(r) ? s.dim(`⎿  ${activity(r.progress)}`) : undefined,
  };
}

/** Tree-drawn lines, or undefined when there is nothing to show (clear the widget). */
export function renderStatus(records: readonly JobRecord[], o: RenderOptions): string[] | undefined {
  const { shown, queued } = select(records);
  if (!shown.length && !queued) return undefined;
  const rows = shown.slice(0, MAX_ROWS).map((r) => row(r, o));
  const more = [shown.length > MAX_ROWS && `+${shown.length - MAX_ROWS} more`, queued > 0 && `${queued} queued`].filter(Boolean).join(", ");
  if (more) rows.push({ head: o.style.dim(more) });
  const live = shown.some(isRunning) || queued > 0;
  const lines = [`${live ? o.style.accent("●") : o.style.dim("○")} ${o.style.bold("Agents")}`];
  rows.forEach(({ head, sub }, i) => {
    const last = i === rows.length - 1;
    lines.push(`${last ? "└─" : "├─"} ${head}`);
    if (sub) lines.push(`${last ? "   " : "│  "}    ${sub}`);
  });
  return lines.map((l) => o.fit(l, o.width));
}
