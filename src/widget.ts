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
        if (mounted) ui.setWidget(KEY, undefined);
        mounted = false;
        tui = undefined;
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
      tui?.requestRender();
      if (!running) return stop();
      timer ??= setInterval(() => {
        frame++;
        update();
      }, TICK_MS);
      timer.unref?.(); // an animation must never keep Pi alive
    } catch {
      // The UI context went stale (reload or session switch); the next bind() recovers.
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
      ui = next;
      tui = undefined;
      mounted = false;
      if (next && !fit) {
        // Pi's width helper understands ANSI and wide characters; load it once, only when there is a UI.
        void import("@earendil-works/pi-tui").then((m) => {
          fit = (line, width) => m.truncateToWidth(line, width);
          measure = m.visibleWidth;
          tui?.requestRender();
        });
      }
      update();
    },
    /** Progress arrived. While something runs the spinner tick repaints within 100ms, so only start the widget if it is not running yet. */
    /** True when Pi's prompt editor owns the keyboard, not one of its dialogs or overlays. Unknown counts as yes. */
    editorFocused: (): boolean => {
      const focused = tui?.focusedComponent as { getText?: unknown; setText?: unknown } | null | undefined;
      return focused == null || (typeof focused.getText === "function" && typeof focused.setText === "function");
    },
    touch: (): void => {
      if (!timer) update();
    },
    update,
    dispose(): void {
      stop();
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
