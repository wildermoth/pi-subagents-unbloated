/** Keyboard control of the status widget: Down at an empty prompt moves a cursor onto the agents, Enter opens an action menu. */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { JobRecord } from "./jobs.ts";
import { selectable } from "./statusbar.ts";

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
      unsubscribe?.();
      unsubscribe = undefined;
      ui = undefined;
      active = false;
      selectedId = undefined;
    },
  };
}
