/** Compact transcript rendering for subagent calls, without changing model-facing results. */
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Params } from "./schema.ts";

interface RenderState {
  finished?: boolean;
  failed?: boolean;
}

interface RenderContext {
  args: Params;
  state: RenderState;
  isError: boolean;
  invalidate(): void;
}

interface Result {
  content: { type: string; text?: string }[];
}

interface ResultOptions {
  expanded: boolean;
  isPartial: boolean;
}

let tui: typeof import("@earendil-works/pi-tui") | undefined;
let loading: Promise<void> | undefined;
let loadFailed = false;

function loadTui(): Promise<void> {
  return (loading ??= import("@earendil-works/pi-tui").then(
    (module) => {
      tui = module;
    },
    () => {
      loadFailed = true;
    },
  ));
}

function clean(text: string): string {
  return stripVTControlCharacters(text);
}

function safe(text: string): string {
  return (
    clean(text)
      // Control characters must not enter the single-line label.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .trim()
  );
}

// Pi renderers are synchronous, so redraw once the terminal library is available.
function component(text: () => string, color: () => "error" | "toolTitle" | "toolOutput", theme: Theme, context: RenderContext): Component {
  if (!tui && !loadFailed) {
    void loadTui()
      .then(() => context.invalidate())
      .catch(() => {
        // A disposed row cannot be redrawn.
      });
  }
  return {
    invalidate() {
      // No cached rendering to clear.
    },
    render(width) {
      const output = text();
      if (!output) return [];
      if (tui) return new tui.Text(theme.fg(color(), output), 0, 0).render(width);
      if (!loadFailed) return [];
      // Conservative fallback if the optional terminal library could not be loaded.
      const max = Math.max(0, Math.floor(width / 2));
      return output.split("\n").map((line) => Array.from(line).slice(0, max).join(""));
    },
  };
}

/** Shows the action without displaying the potentially long delegation task. */
export function renderCall(args: Params, theme: Theme, context: RenderContext): Component {
  const state = context.state;
  const action = typeof args?.action === "string" ? safe(args.action) || "subagent" : "subagent";
  const value = action === "start" ? args?.agent : args?.id;
  const subject = typeof value === "string" ? safe(value) : action === "start" ? "agent" : "";
  return component(
    () =>
      action === "start"
        ? `${state.failed ? "Subagent failed:" : state.finished ? "Launched" : "Launching"} ${subject}`
        : `Subagent ${action}${subject ? ` ${subject}` : ""}`,
    () => (state.failed ? "error" : "toolTitle"),
    theme,
    context,
  );
}

/** Displays results and failures, suppressing only the routine background launch acknowledgement. */
export function renderResult(result: Result, options: ResultOptions, theme: Theme, context: RenderContext): Component {
  context.state.finished = !options.isPartial;
  context.state.failed = context.isError;
  const routineLaunch = context.args?.action === "start" && !context.args.wait && !context.isError && !options.isPartial;
  const output = routineLaunch
    ? ""
    : result.content
        .filter((block) => block.type === "text")
        .map((block) => clean(block.text ?? ""))
        .join("\n");
  const lines = output.split("\n");
  const shown = options.expanded ? lines : lines.slice(0, 5);
  const remaining = lines.length - shown.length;
  const suffix = remaining ? `\n... (${remaining} more lines, expand to view)` : "";
  return component(
    () => shown.join("\n") + suffix,
    () => (context.isError ? "error" : "toolOutput"),
    theme,
    context,
  );
}
