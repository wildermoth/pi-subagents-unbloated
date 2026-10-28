/** Mounts the job list above Pi's editor and keeps it fresh: re-renders on change, animates only while something runs. */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { JobRecord } from "./jobs.ts";
import { renderStatus, select, type Style } from "./statusbar.ts";

const KEY = "subagents";
const TICK_MS = 100;

export function createWidget(records: () => readonly JobRecord[]) {
  let ui: ExtensionUIContext | undefined;
  let tui: { requestRender(): void } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let fit: ((line: string, width: number) => string) | undefined;
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
              render: (width) => renderStatus(records(), { now: Date.now(), frame, width, style, fit: fit ?? ((l) => l) }) ?? [],
              invalidate: () => {},
            };
          },
          { placement: "aboveEditor" },
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
          tui?.requestRender();
        });
      }
      update();
    },
    /** Progress arrived. While something runs the spinner tick repaints within 100ms, so only start the widget if it is not running yet. */
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
