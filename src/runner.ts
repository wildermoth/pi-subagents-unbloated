/** Runs one Pi child over `--mode rpc` per RunSpec. See types.ts for the contract. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcConnection, RpcError, type ExitInfo, type RpcResponse } from "./protocol.ts";
import type { Child, FailureKind, RunResult, RunSpec, Runner } from "./types.ts";

export interface RunnerOptions {
  piCommand?: () => { command: string; args: string[] };
  /** Max UTF-8 bytes of result text, marker included. Default 8192. */
  maxResultBytes?: number;
  /** Wait between each escalation step (stdin close, SIGTERM, SIGKILL). Default 2000. */
  graceMs?: number;
}

const KILL_WAIT_MS = 2000;
const STEER_TIMEOUT_MS = 10_000;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const POSIX = process.platform !== "win32";

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  read?: (p: string) => string | undefined;
  /** Absolute path of some file inside the Pi package, or undefined when not installed. */
  resolvePackage?: () => string | undefined;
  /** Defaults to process.execPath; Pi's bundle needs a real node, not e.g. bun. */
  execPath?: string;
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const isPiEntry = (p: string) => /pi-coding-agent/.test(p) || /^(pi|cli)(\.[cm]?js)?$/.test(basename(p));

function defaultResolvePackage(): string | undefined {
  try {
    const url = import.meta.resolve(PI_PACKAGE);
    return url.startsWith("file:") ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

const isNode = (exec: string) => /^node(\.exe)?$/i.test(basename(exec.replace(/\\/g, "/")));

const defaultExists = (p: string) => existsSync(p);
function defaultRead(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/** Walk up from a file inside the package to its package.json and return the bin.pi script. */
function packageBin(o: Required<ResolveOptions>, P: typeof posix): string | undefined {
  const file = o.resolvePackage();
  if (!file) return undefined;
  for (let dir = P.dirname(file); ; dir = P.dirname(dir)) {
    const text = o.exists(P.join(dir, "package.json")) ? o.read(P.join(dir, "package.json")) : undefined;
    if (text) {
      try {
        const pkg = JSON.parse(text);
        if (pkg.name === PI_PACKAGE) {
          const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
          const target = typeof bin === "string" ? P.resolve(dir, bin) : undefined;
          return target && o.exists(target) ? target : undefined;
        }
      } catch {
        // unreadable package.json: keep walking
      }
    }
    if (P.dirname(dir) === dir) return undefined;
  }
}

/** Find an executable named `name` on PATH (PATHEXT on Windows) without shelling out. */
function findOnPath(env: NodeJS.ProcessEnv, win: boolean, o: Required<ResolveOptions>): string | undefined {
  const P = win ? win32 : posix;
  const pathVar = win ? (env.PATH ?? env.Path ?? env.path ?? "") : (env.PATH ?? "");
  const exts = win ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of pathVar.split(win ? ";" : ":").filter(Boolean)) {
    for (const ext of exts) {
      const p = P.join(dir.replace(/^"|"$/g, ""), "pi" + ext);
      if (o.exists(p)) return p;
    }
  }
  return undefined;
}

/** Turn a resolved Windows path into a spawnable command; .cmd/.bat shims become node + target script. */
function windowsCommand(p: string, o: Required<ResolveOptions>): { command: string; args: string[] } {
  const node = isNode(o.execPath) ? o.execPath : "node";
  if (/\.[cm]?js$/i.test(p)) return { command: node, args: [p] };
  if (!/\.(cmd|bat)$/i.test(p)) return { command: p, args: [] };
  const m = /["']?%~?dp0%?[\\/]+([^"'%\r\n]+?\.[cm]?js)["']?/i.exec(o.read(p) ?? "");
  const target = m ? win32.resolve(win32.dirname(p), m[1]!) : undefined;
  if (!target || !o.exists(target)) {
    throw new Error(`cannot launch Pi from shim ${p}: no target .js found in it; set PI_BIN to the Pi cli.js or an .exe`);
  }
  return { command: node, args: [target] };
}

/** PI_BIN, then this process's own Pi entry, then the installed Pi package, then `pi` on PATH. */
export function resolvePiCommand(
  env: NodeJS.ProcessEnv = process.env,
  argv1: string | undefined = process.argv[1],
  opts: ResolveOptions = {},
): { command: string; args: string[] } {
  const platform = opts.platform ?? process.platform;
  const win = platform === "win32";
  const o: Required<ResolveOptions> = {
    platform,
    exists: opts.exists ?? defaultExists,
    read: opts.read ?? defaultRead,
    resolvePackage: opts.resolvePackage ?? defaultResolvePackage,
    execPath: opts.execPath ?? process.execPath,
  };
  const fromPath = (p: string) => (win ? windowsCommand(p, o) : { command: p, args: [] });
  if (env.PI_BIN) return fromPath(env.PI_BIN);
  // Only trust argv[1] when it looks like Pi's entry point (not e.g. a test runner script)
  if (argv1 && isPiEntry(argv1)) return { command: process.execPath, args: [argv1] };
  let pkgBin: string | undefined;
  try {
    pkgBin = isNode(o.execPath) ? packageBin(o, win ? win32 : posix) : undefined;
  } catch {
    pkgBin = undefined;
  }
  if (pkgBin) return { command: o.execPath, args: [pkgBin] };
  if (!win) return { command: "pi", args: [] };
  const found = findOnPath(env, true, o);
  if (!found) throw new Error("cannot find `pi` on PATH (checked PATHEXT); install Pi or set PI_BIN");
  return windowsCommand(found, o);
}

export function buildArgs(spec: RunSpec): string[] {
  const a = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--no-mcp", "--offline", "--no-session"];
  if (spec.tools) a.push(...(spec.tools.length ? ["--tools", spec.tools.join(",")] : ["--no-tools"]));
  if (spec.model) a.push("--model", spec.model);
  if (spec.thinking) a.push("--thinking", spec.thinking);
  a.push("--append-system-prompt", spec.systemPrompt, spec.trusted ? "--approve" : "--no-approve");
  return a;
}

const live = new Set<ChildProcess>();
let exitHook = false;

function signalTree(proc: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (POSIX && proc.pid) process.kill(-proc.pid, sig);
    else proc.kill(sig);
  } catch {
    // ESRCH: already gone, nothing to signal
  }
}

/** Synchronously SIGKILL every live child. Registered on process exit; callable by shutdown code. */
export function killAll(): void {
  for (const p of live) signalTree(p, "SIGKILL");
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, truncated: false };
  const marker = `\n[truncated: ${buf.length - max} of ${buf.length} bytes omitted]`;
  let cut = Math.max(0, max - Buffer.byteLength(marker));
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--; // do not split a UTF-8 sequence
  return { text: buf.subarray(0, cut).toString("utf8") + marker, truncated: true };
}

function assistantText(msg: any): string {
  if (!Array.isArray(msg?.content)) return typeof msg?.content === "string" ? msg.content : "";
  return msg.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("");
}

export function createRunner(opts: RunnerOptions = {}): Runner {
  const piCommand = opts.piCommand ?? (() => resolvePiCommand());
  const maxResultBytes = opts.maxResultBytes ?? 8192;
  const graceMs = opts.graceMs ?? 2000;

  return {
    start(spec: RunSpec): Child {
      let resolveDone!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => (resolveDone = r));
      let outcome: RunResult | undefined;
      let wantAbort = false;
      let conn: RpcConnection | undefined;
      let proc: ChildProcess | undefined;
      let acked = false;
      let settled = false;
      let lastAssistant: any;
      let runTimer: ReturnType<typeof setTimeout> | undefined;

      const waitExit = async (ms: number): Promise<boolean> => {
        if (!conn) return true;
        let t: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<false>((r) => (t = setTimeout(() => r(false), ms)));
        try {
          return await Promise.race([conn.exited.then(() => true as const), timeout]);
        } finally {
          clearTimeout(t);
        }
      };

      const terminate = async (): Promise<void> => {
        if (!conn || !proc) return;
        if (wantAbort) void conn.send({ type: "abort" }, graceMs).catch(() => {}); // best effort; escalation below guarantees exit
        conn.closeInput();
        if (await waitExit(graceMs)) return;
        signalTree(proc, "SIGTERM");
        if (await waitExit(graceMs)) return;
        signalTree(proc, "SIGKILL");
        await waitExit(KILL_WAIT_MS);
      };

      // Single terminal transition; the first caller wins.
      const decide = (r: RunResult, abort = false): void => {
        if (outcome) return;
        outcome = r;
        wantAbort = abort;
        clearTimeout(runTimer);
        void (async () => {
          try {
            await terminate();
          } finally {
            resolveDone(r);
          }
        })();
      };
      const fail = (kind: FailureKind, message: string): void =>
        decide({ status: "failed", text: "", truncated: false, failure: { kind, message } });

      const finishIfSettled = (): void => {
        if (outcome || !acked || !settled) return;
        const stop = lastAssistant?.stopReason;
        if (!lastAssistant) return fail("protocol", "agent_settled without an assistant message");
        if (stop === "error") return fail("provider", String(lastAssistant.errorMessage ?? "provider error"));
        if (stop === "aborted") return fail("provider", "run aborted unexpectedly");
        if (stop !== "stop" && stop !== "length") return fail("protocol", `unexpected stopReason: ${String(stop)}`);
        const t = truncate(assistantText(lastAssistant), maxResultBytes);
        decide({ status: "completed", text: t.text, truncated: t.truncated });
      };

      const onEvent = (ev: Record<string, any>): void => {
        switch (ev.type) {
          case "message_end":
            if (ev.message?.role === "assistant") lastAssistant = ev.message;
            break;
          case "agent_end":
            if (Array.isArray(ev.messages)) {
              for (let i = ev.messages.length - 1; i >= 0; i--) {
                if (ev.messages[i]?.role === "assistant") { lastAssistant = ev.messages[i]; break; }
              }
            }
            break;
          case "agent_settled":
            settled = true;
            finishIfSettled();
            break;
          case "extension_ui_request":
            // Policy: never block on UI. Deny dialogs; fire-and-forget kinds need no reply.
            if (DIALOG_METHODS.has(ev.method) && typeof ev.id === "string") {
              conn?.sendNoReply({ type: "extension_ui_response", id: ev.id, cancelled: true });
            }
            break;
        }
      };

      const onExit = (info: ExitInfo): void => {
        if (proc) live.delete(proc);
        if (info.spawnError) return fail("launch", `cannot spawn Pi: ${info.spawnError.message}`);
        const tail = conn?.stderrTail().trim().slice(-500);
        const how = info.signal ? `signal ${info.signal}` : `code ${info.code}`;
        fail("exit", `Pi exited (${how}) before the run settled${tail ? `; stderr: ${tail}` : ""}`);
      };

      const onAck = (r: RpcResponse): void => {
        if (!r.success) return fail("rejected", `prompt rejected: ${String(r.error)}`);
        const d = r.data?.disposition;
        if (d !== "started") return fail("rejected", `prompt not started (disposition: ${String(d)})`);
        acked = true;
        finishIfSettled();
      };

      const onAckFail = (e: unknown): void => {
        const code = e instanceof RpcError ? e.code : "protocol";
        const msg = e instanceof Error ? e.message : String(e);
        if (code === "timeout") fail("timeout", `no prompt acknowledgement within ${spec.launchTimeoutMs}ms`);
        else if (code === "exit" || code === "stdin") fail("exit", msg);
        else fail("protocol", msg);
      };

      try {
        const cmd = piCommand();
        proc = spawn(cmd.command, [...cmd.args, ...buildArgs(spec)], {
          cwd: spec.cwd,
          env: { ...process.env, PI_SUBAGENT_CHILD: "1" },
          shell: false,
          detached: POSIX,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        fail("launch", `cannot spawn Pi: ${(e as Error).message}`);
        return { done, steer: async () => { throw new Error("run is finished"); }, cancel: async () => { await done; } };
      }

      live.add(proc);
      if (!exitHook) {
        exitHook = true;
        process.once("exit", killAll);
      }
      conn = new RpcConnection(proc, {
        onEvent,
        onProtocolError: (e) => fail("protocol", e.message),
        onExit,
      });
      void conn.exited.then(() => { live.delete(proc!); });

      runTimer = setTimeout(() => fail("timeout", `run did not settle within ${spec.timeoutMs}ms`), spec.timeoutMs);
      // Listeners are installed above, so no event can be missed before the prompt goes out.
      conn.send({ type: "prompt", message: spec.task }, spec.launchTimeoutMs).then(onAck, onAckFail);

      return {
        done,
        async steer(message: string): Promise<void> {
          if (outcome || !conn) throw new Error("run is finished");
          const r = await conn.send({ type: "steer", message }, STEER_TIMEOUT_MS);
          if (!r.success) throw new Error(`steer rejected: ${String(r.error)}`);
        },
        async cancel(): Promise<void> {
          decide({ status: "cancelled", text: "", truncated: false }, true);
          await done;
        },
      };
    },
  };
}
