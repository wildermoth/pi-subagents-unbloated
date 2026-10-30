/** Mounts the job list below Pi's editor and keeps it fresh: re-renders on change, animates only while something runs. */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { JobRecord } from "./jobs.ts";
import { renderStatus, select, type Style } from "./statusbar.ts";

const KEY = "subagents";
const TICK_MS = 100;

/** What the list cursor adds to the drawing; both read live so a repaint always matches the keyboard state. */
export interface WidgetView {
  selected(): string | undefined;
  active(): boolean;
}

export function createWidget(records: () => readonly JobRecord[], view?: WidgetView) {
  let ui: ExtensionUIContext | undefined;
  let tui: { requestRender(): void; focusedComponent?: unknown } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let fit: ((line: string, width: number) => string) | undefined;
  let measure: ((line: string) => number) | undefined;
  let mounted = false; // setWidget may call its factory later, so track mounting here, not via tui
  let frame = 0;
  let restoreCursor: (() => void) | undefined;
  let cursorEditor: unknown;

  function resetCursor(): void {
    restoreCursor?.();
    restoreCursor = undefined;
    cursorEditor = undefined;
  }

  function syncCursor(): void {
    const editor = tui?.focusedComponent as { render?: (width: number) => string[]; getText?: unknown; setText?: unknown } | undefined;
    const hide =
      view?.active() &&
      editor &&
      typeof editor.render === "function" &&
      typeof editor.getText === "function" &&
      typeof editor.setText === "function";
    if (hide && cursorEditor === editor) return;
    resetCursor();
    if (!hide || !editor.render) return;
    const original = editor.render;
    const wrapped = (width: number) =>
      original
        .call(editor, width)
        .map((line) => line.replaceAll("\x1b_pi:c\x07", "").replaceAll("\x1b_pi:fc\x07", "").replaceAll("\x1b_pi:/fc\x07", ""));
    editor.render = wrapped;
    cursorEditor = editor;
    restoreCursor = () => {
      if (editor.render === wrapped) editor.render = original;
    };
  }

  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };

  /** Show, refresh or clear the widget to match the current jobs. */
  function update(): void {
    if (!ui) return;
    try {
      const { shown, queued, running } = select(records());
      if (!shown.length && !queued) {
        stop();
        resetCursor();
        if (mounted) ui.setWidget(KEY, undefined);
        mounted = false;
        return;
      }
      if (!mounted) {
        mounted = true;
        ui.setWidget(
          KEY,
          (t, theme) => {
            tui = t;
            const style: Style = {
              accent: (s) => theme.fg("accent", s),
              dim: (s) => theme.fg("dim", s),
              success: (s) => theme.fg("success", s),
              warn: (s) => theme.fg("warning", s),
              error: (s) => theme.fg("error", s),
              bold: (s) => theme.bold(s),
            };
            return {
              render: (width) =>
                renderStatus(records(), {
                  now: Date.now(),
                  frame,
                  width,
                  style,
                  fit: fit ?? ((l) => l),
                  measure,
                  selected: view?.selected(),
                  hint: view?.active(),
                }) ?? [],
              invalidate: () => {},
            };
          },
          { placement: "belowEditor" },
        );
      }
      syncCursor();
      tui?.requestRender();
      if (!running) return stop();
      timer ??= setInterval(() => {
        frame++;
        update();
      }, TICK_MS);
      timer.unref?.(); // an animation must never keep Pi alive
    } catch {
      // The UI context went stale (reload or session switch); the next bind() recovers.
      resetCursor();
      ui = tui = undefined;
      mounted = false;
      stop();
    }
  }

  return {
    /** Call with the current UI context whenever it may have changed; a new context remounts the widget. */
    bind(next: ExtensionUIContext | undefined): void {
      if (next === ui) return;
      stop();
      resetCursor();
      ui = next;
      tui = undefined;
      mounted = false;
      if (next && !fit) {
        // Pi's width helper understands ANSI and wide characters; load it once, only when there is a UI.
        void import("@earendil-works/pi-tui")
          .then((m) => {
            fit = (line, width) => m.truncateToWidth(line, width);
            measure = m.visibleWidth;
            tui?.requestRender();
          })
          .catch(() => {
            // Width helpers are optional, and a later bind can retry.
          });
      }
      update();
    },
    /** True when the editor owns the keyboard, not a dialog or an unbound UI. */
    editorFocused: (): boolean => {
      const focused = tui?.focusedComponent as { getText?: unknown; setText?: unknown } | null | undefined;
      return !!tui && (focused == null || (typeof focused.getText === "function" && typeof focused.setText === "function"));
    },
    /** Progress arrives frequently; the running animation already schedules a repaint. */
    touch: (): void => {
      if (!timer) update();
    },
    update,
    dispose(): void {
      stop();
      resetCursor();
      try {
        if (mounted) ui?.setWidget(KEY, undefined);
      } catch {
        // already gone
      }
      ui = tui = undefined;
      mounted = false;
    },
  };
}
