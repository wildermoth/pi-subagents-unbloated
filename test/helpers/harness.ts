import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../../src/index.ts";
import type { Child, RunResult, RunSpec, Runner } from "../../src/types.ts";

export const ok = (text: string): RunResult => ({ status: "completed", text, truncated: false });

export interface Ctl {
  spec: RunSpec;
  finish(r: RunResult): void;
  steered: string[];
  cancelled: number;
}

export function harness(branch: unknown[] = [], failSend = { on: false }, injected?: Runner) {
  const handlers: Record<string, (e: any, c: any) => any> = {};
  const sent: { msg: any; opts: any }[] = [];
  const entries: { type: string; data: any }[] = [];
  let tool: any;
  const ctls: Ctl[] = [];
  const runner: Runner = {
    start(spec): Child {
      let resolve!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => (resolve = r));
      const ctl: Ctl = { spec, finish: resolve, steered: [], cancelled: 0 };
      ctls.push(ctl);
      return {
        done,
        steer: async (m) => void ctl.steered.push(m),
        cancel: async () => {
          ctl.cancelled++;
          resolve({ status: "cancelled", text: "", truncated: false });
        },
      };
    },
  };
  let active = ["read", "bash", "grep", "subagent"];
  const pi = {
    registerTool: (t: any) => (tool = t),
    getActiveTools: () => active,
    registerCommand: () => {},
    on: (n: string, h: any) => (handlers[n] = h),
    sendMessage: (msg: any, opts: any) => {
      if (failSend.on) throw new Error("send failed");
      sent.push({ msg, opts });
    },
    appendEntry: (type: string, data: any) => entries.push({ type, data }),
  };
  register(pi as any, injected ?? runner);
  let idle = true;
  // Like Pi, build the widget component on mount; tests read what it would draw right now.
  let mounted: { render(w: number): string[] } | undefined;
  const keyHandlers: ((data: string) => { consume?: boolean } | undefined)[] = [];
  const ui = {
    onTerminalInput: (h: (data: string) => { consume?: boolean } | undefined) => {
      keyHandlers.push(h);
      return () => void keyHandlers.splice(keyHandlers.indexOf(h), 1);
    },
    getEditorText: () => "",
    setWidget: (_key: string, content: unknown) => {
      mounted =
        typeof content === "function"
          ? content({ requestRender() {} }, { fg: (_c: string, s: string) => s, bold: (s: string) => s })
          : undefined;
    },
  };
  const ctx = (cwd: string, trusted = true) => ({
    hasUI: true,
    mode: "tui",
    modelRegistry: { find: () => undefined },
    ui,
    cwd,
    isProjectTrusted: () => trusted,
    isIdle: () => idle,
    model: undefined,
    thinkingLevel: "low",
    sessionManager: { getBranch: () => branch },
  });
  return {
    handlers,
    sent,
    entries,
    tool,
    ctls,
    ctx,
    keyHandlers,
    widgetLines: () => mounted?.render(120),
    setIdle: (v: boolean) => (idle = v),
    setActiveTools: (t: string[]) => (active = t),
  };
}

export async function project(dirs: string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "psu-"));
  dirs.push(cwd);
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(join(cwd, ".pi", "agents", "scout.md"), "---\nname: scout\ndescription: Explore\ntools: read,grep\n---\nBe brief.");
  return cwd;
}

/** Wait until n children have been started (first call pays the cold dynamic imports). */
export async function started(h: { ctls: unknown[] }, n = 1) {
  for (let i = 0; i < 2000 && h.ctls.length < n; i++) await new Promise((r) => setTimeout(r, 1));
}
export const tick = () => new Promise((r) => setTimeout(r, 5));
export const run = (h: ReturnType<typeof harness>, cwd: string, p: object, signal?: AbortSignal) =>
  h.tool.execute("t", p, signal, undefined, h.ctx(cwd));
export const txt = (r: any) => r.content[0].text as string;
