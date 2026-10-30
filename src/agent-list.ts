/** Keyboard control of the status widget: Down at an empty prompt moves a cursor onto the agents, Enter opens an action menu. */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { JobRecord } from "./jobs.ts";
import { activity, elapsed, selectable, tokens } from "./statusbar.ts";

type Keys = Pick<typeof import("@earendil-works/pi-tui"), "isKeyRelease" | "matchesKey">;

export interface AgentListOptions {
  records(): readonly JobRecord[];
  /** Repaint the widget after the cursor or activity changed. */
  redraw(): void;
  /** False while one of Pi's dialogs or overlays has the keyboard. */
  editorFocused(): boolean;
  steer(id: string, message: string): Promise<void>;
  cancel(id: string): Promise<unknown>;
  /** Pick a model and thinking level for the named agent. */
  configure(agent: string): Promise<void>;
  /** Injectable so tests need no terminal library. */
  loadKeys?: () => Promise<Keys>;
}

const isLive = (r: JobRecord) => r.state === "starting" || r.state === "running";

export function createAgentList(o: AgentListOptions) {
  let active = false;
  let busy = false; // an action menu is open: it owns the keyboard, not us
  let index = 0;
  let selectedId: string | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let keys: Keys | undefined;
  let closeManager: (() => void) | undefined;

  const rows = () => selectable(o.records());

  function move(to: number): void {
    const list = rows();
    index = Math.max(0, Math.min(list.length - 1, to));
    selectedId = list[index]?.id;
    o.redraw();
  }
  /** Rows come and go as jobs finish or get read; keep the cursor on the same job, or the nearest row if it left. */
  function resync(): void {
    const list = rows();
    const at = list.findIndex((r) => r.id === selectedId);
    index = Math.max(0, Math.min(list.length - 1, at >= 0 ? at : index));
    selectedId = list[index]?.id;
  }
  function close(): void {
    active = false;
    selectedId = undefined;
    o.redraw();
  }

  /** What can be done to this job, as menu label -> action. */
  function actionsFor(r: JobRecord, u: ExtensionUIContext): Record<string, () => Promise<void>> {
    const note = (e: unknown) => u.notify(e instanceof Error ? e.message : String(e), "error");
    const a: Record<string, () => Promise<void>> = {};
    if (isLive(r)) {
      a.Steer = async () => {
        const message = await u.input(`Steer ${r.agent}`, "message");
        if (message?.trim()) await o.steer(r.id, message.trim()).catch(note);
      };
      a.Cancel = async () => void (await o.cancel(r.id).catch(note));
    } else if (r.state === "queued") {
      a.Cancel = async () => void (await o.cancel(r.id).catch(note));
    } else {
      a["Show result"] = async () => {
        const res = r.result;
        await u.editor(
          `${r.agent} (${r.state})`,
          res?.status === "failed" ? `${res.text}\n\n${res.failure.message}`.trim() : (res?.text ?? ""),
        );
      };
    }
    a["Model and thinking"] = () => o.configure(r.agent).catch(note);
    return a;
  }

  async function openActions(r: JobRecord): Promise<void> {
    if (!ui) return;
    busy = true;
    try {
      const actions = actionsFor(r, ui);
      const choice = await ui.select(`${r.agent}: ${r.task.slice(0, 50)}`, [...Object.keys(actions), "Back"]);
      await actions[choice ?? ""]?.();
    } finally {
      busy = false;
      resync(); // the job may have finished or been delivered meanwhile
      if (rows().length === 0) close();
      else o.redraw();
    }
  }

  /** All session jobs, including delivered results, remain inspectable in the manager. */
  async function openManager(): Promise<void> {
    if (!ui || !keys || busy) return;
    const u = ui;
    const k = keys;
    busy = true;
    close();
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const { truncateToWidth, visibleWidth } = await import("@earendil-works/pi-tui");
      if (ui !== u) return;
      const picked = await u.custom<JobRecord | undefined>(
        (tui, theme, _bindings, done) => {
          let selected: string | undefined;
          let cursor = 0;
          let scroll = 0;
          const groups = () => {
            const records = o.records();
            return [
              { title: "Working", jobs: records.filter(isLive) },
              { title: "Queued", jobs: records.filter((r) => r.state === "queued") },
              { title: "Needs attention", jobs: records.filter((r) => r.state === "failed" || r.state === "interrupted") },
              { title: "Completed", jobs: records.filter((r) => r.state === "completed" || r.state === "cancelled") },
            ];
          };
          const sync = () => {
            const jobs = groups().flatMap((group) => group.jobs);
            const at = jobs.findIndex((r) => r.id === selected);
            cursor = Math.max(0, Math.min(jobs.length - 1, at >= 0 ? at : cursor));
            selected = jobs[cursor]?.id;
            return jobs;
          };
          closeManager = () => done(undefined);
          timer = setInterval(() => tui.requestRender(), 100);
          timer.unref?.();
          const renderRow = (r: JobRecord, width: number): string => {
            const mark = r.id === selected ? ">" : " ";
            const summary = isLive(r)
              ? activity(r.progress)
              : r.result?.status === "failed"
                ? r.result.failure.message
                : (r.result?.text ?? r.task);
            const left = `${mark} ${r.agent} (${r.state})  ${summary}`.replace(/\s+/g, " ");
            const stats = `${elapsed((r.endedAt ?? Date.now()) - (r.startedAt ?? r.createdAt))} · ${tokens(r.progress?.tokens ?? 0)} tokens`;
            const right = truncateToWidth(stats, width);
            const room = Math.max(0, width - visibleWidth(right) - 2);
            const label = truncateToWidth(left, room);
            return room > 0 ? label + " ".repeat(Math.max(2, width - visibleWidth(label) - visibleWidth(right))) + right : right;
          };
          return {
            render(width) {
              sync();
              const entries: { text: string; id?: string; heading?: string }[] = [];
              for (const group of groups()) {
                if (!group.jobs.length) continue;
                entries.push({ text: theme.fg("accent", group.title), heading: group.title });
                for (const r of group.jobs) {
                  entries.push({ text: renderRow(r, width), id: r.id });
                }
              }
              // Reserve title, current section heading and key hints. Keep the cursor inside the viewport.
              const height = Math.max(1, tui.terminal?.rows ?? 24);
              const capacity = Math.max(1, height - 7);
              const at = entries.findIndex((entry) => entry.id === selected);
              if (at < scroll) scroll = Math.max(0, at);
              if (at >= scroll + capacity) scroll = at - capacity + 1;
              scroll = Math.min(scroll, Math.max(0, entries.length - capacity));
              const section = entries.slice(0, scroll + 1).findLast((entry) => entry.heading)?.heading;
              const lines = [theme.bold("Agents"), theme.fg("dim", "Conversation in background · right or esc returns"), ""];
              if (scroll > 0 && section && !entries[scroll]?.heading) lines.push(theme.fg("accent", section));
              lines.push(...entries.slice(scroll, scroll + capacity).map((entry) => entry.text));
              if (!entries.length) lines.push(theme.fg("dim", "No agents in this session"));
              while (lines.length < height - 1) lines.push("");
              lines.push(theme.fg("dim", "↑↓ select · enter actions · →/esc return"));
              return lines.slice(0, height).map((line) => {
                const fitted = truncateToWidth(line, width);
                return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
              });
            },
            handleInput(data) {
              if (k.isKeyRelease(data)) return;
              const jobs = sync();
              if (k.matchesKey(data, "escape") || k.matchesKey(data, "right")) done(undefined);
              else if (k.matchesKey(data, "enter")) done(jobs[cursor]);
              else if (k.matchesKey(data, "up") || k.matchesKey(data, "down")) {
                cursor = Math.max(0, Math.min(jobs.length - 1, cursor + (k.matchesKey(data, "up") ? -1 : 1)));
                selected = jobs[cursor]?.id;
                tui.requestRender();
              }
            },
            invalidate() {
              // Every render reads the current records, so there is no cache to invalidate.
            },
          };
        },
        { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } },
      );
      clearInterval(timer);
      closeManager = undefined;
      if (picked && ui === u) {
        const current = o.records().find((r) => r.id === picked.id);
        if (current) await openActions(current);
      }
    } finally {
      clearInterval(timer);
      closeManager = undefined;
      busy = false;
    }
  }

  /** Down at an empty prompt puts the cursor on the first agent. */
  function activate(data: string, k: Keys): { consume: true } | undefined {
    if (!k.matchesKey(data, "down") || ui?.getEditorText() !== "" || rows().length === 0) return undefined;
    active = true;
    move(0);
    return { consume: true };
  }

  /** Keys while the cursor is on the list. Anything it does not use closes the list and goes on to the editor. */
  function navigate(data: string, k: Keys): { consume: true } | undefined {
    if (k.matchesKey(data, "down")) move(index + 1);
    else if (k.matchesKey(data, "up")) {
      if (index === 0) close();
      else move(index - 1);
    } else if (k.matchesKey(data, "escape")) {
      close(); // consumed: Esc must close the list, not cancel Pi's turn
    } else if (k.matchesKey(data, "enter")) {
      const job = rows()[index];
      if (job) void openActions(job);
      else close();
    } else {
      close();
      return undefined;
    }
    return { consume: true };
  }

  /** Returns `{ consume: true }` to swallow a key, or undefined to let Pi have it. */
  function handleKey(data: string): { consume: true } | undefined {
    if (!keys || !ui || busy || keys.isKeyRelease(data) || !o.editorFocused()) return undefined;
    if (keys.matchesKey(data, "left") && ui.getEditorText() === "") {
      void openManager().catch((error: unknown) => ui?.notify(error instanceof Error ? error.message : String(error), "error"));
      return { consume: true };
    }
    if (!active) return activate(data, keys);
    resync();
    return navigate(data, keys);
  }

  return {
    /** The job id the cursor is on, while the list is active. */
    selected: (): string | undefined => selectedId,
    active: (): boolean => active,
    /** Listen for keys on this UI context; a new context replaces the old listener. */
    async bind(next: ExtensionUIContext | undefined): Promise<void> {
      if (next === ui) return;
      closeManager?.();
      unsubscribe?.();
      unsubscribe = undefined;
      active = false;
      selectedId = undefined;
      ui = next;
      if (!next) return;
      keys ??= await (o.loadKeys ?? (() => import("@earendil-works/pi-tui")))();
      if (ui !== next) return; // rebound while the key helpers loaded
      unsubscribe = next.onTerminalInput(handleKey);
    },
    dispose(): void {
      closeManager?.();
      unsubscribe?.();
      unsubscribe = undefined;
      ui = undefined;
      active = false;
      selectedId = undefined;
    },
  };
}
