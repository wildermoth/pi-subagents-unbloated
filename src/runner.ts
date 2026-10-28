/** Runs one Pi child over `--mode rpc` per RunSpec. See types.ts for the contract. */
import { spawn, type ChildProcess } from "node:child_process";
import { asRecord, partialOf, settledOutcome } from "./outcome.ts";
import { createTracker } from "./progress.ts";
import { resolvePiCommand } from "./pi-command.ts";
import { RpcConnection, RpcError, type ExitInfo, type JsonRecord, type RpcResponse } from "./protocol.ts";
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

export function buildArgs(spec: RunSpec): string[] {
  const a = [
    "--mode",
    "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
    "--offline",
    "--no-session",
  ];
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
      // eslint-disable-next-line prefer-const -- assigned after the closures that read it are defined
      let conn: RpcConnection | undefined;
      let proc: ChildProcess | undefined;
      let acked = false;
      let settled = false;
      let lastAssistant: JsonRecord | undefined;
      // eslint-disable-next-line prefer-const -- assigned after the closures that read it are defined
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
        if (!(await waitExit(graceMs))) {
          signalTree(proc, "SIGTERM");
          if (!(await waitExit(graceMs))) {
            signalTree(proc, "SIGKILL");
            await waitExit(KILL_WAIT_MS);
          }
        }
        // A leader exiting does not imply its process group has exited too.
        if (POSIX && proc.pid) {
          try {
            process.kill(-proc.pid, 0);
          } catch {
            return;
          }
          signalTree(proc, "SIGTERM");
          await new Promise((r) => setTimeout(r, graceMs));
          signalTree(proc, "SIGKILL");
        }
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
            if (proc) live.delete(proc);
            resolveDone(r);
          }
        })();
      };
      const partial = () => partialOf(lastAssistant, maxResultBytes);
      const fail = (kind: FailureKind, message: string): void => decide({ status: "failed", ...partial(), failure: { kind, message } });

      const finishIfSettled = (): void => {
        if (outcome || !acked || !settled) return;
        decide(settledOutcome(lastAssistant, maxResultBytes));
      };

      const track = createTracker(spec.onProgress);

      const onEvent = (ev: JsonRecord): void => {
        track(ev);
        switch (ev.type) {
          case "message_end":
            if (asRecord(ev.message)?.role === "assistant") {
              lastAssistant = ev.message as JsonRecord;
            }
            break;
          case "agent_end":
            if (Array.isArray(ev.messages)) {
              for (let i = ev.messages.length - 1; i >= 0; i--) {
                const m = asRecord(ev.messages[i]);
                if (m?.role === "assistant") {
                  lastAssistant = m;
                  break;
                }
              }
            }
            break;
          case "agent_settled":
            settled = true;
            finishIfSettled();
            break;
          case "extension_ui_request":
            // Policy: never block on UI. Deny dialogs; fire-and-forget kinds need no reply.
            if (typeof ev.method === "string" && DIALOG_METHODS.has(ev.method) && typeof ev.id === "string") {
              conn?.sendNoReply({ type: "extension_ui_response", id: ev.id, cancelled: true });
            }
            break;
        }
      };

      const onExit = (info: ExitInfo): void => {
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
        return {
          done,
          steer: () => Promise.reject(new Error("run is finished")),
          cancel: async () => {
            await done;
          },
        };
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
          decide({ status: "cancelled", ...partial() }, true);
          await done;
        },
      };
    },
  };
}
