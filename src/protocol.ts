/** LF-only JSONL framing and a small id-correlated RPC connection over a child's stdio. */
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type RpcErrorCode = "timeout" | "exit" | "stdin" | "busy" | "protocol";

export class RpcError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface FramerOptions {
  /** Max chars in one incomplete record; exceeding it is fatal for the framer. */
  maxRecordChars: number;
  onLine(line: string): void;
  onOverflow(): void;
}

/** Splits on LF only (never U+2028/2029), strips one trailing CR, UTF-8 safe across chunks. */
export class JsonlFramer {
  private readonly decoder = new StringDecoder("utf8");
  private buf = "";
  private scanned = 0;
  private dead = false;
  constructor(private readonly opts: FramerOptions) {}

  push(chunk: Buffer | string): void {
    if (this.dead) return; // keep draining, drop data
    this.buf += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drain();
  }

  /** Flush a final unterminated record at EOF. */
  end(): void {
    if (this.dead) return;
    this.buf += this.decoder.end();
    this.drain();
    if (this.dead) return;
    if (this.buf.length > 0) this.emit(this.buf);
    this.buf = "";
    this.scanned = 0;
  }

  private drain(): void {
    let start = 0;
    let i: number;
    while (!this.dead && (i = this.buf.indexOf("\n", Math.max(start, this.scanned))) >= 0) {
      if (i - start > this.opts.maxRecordChars) return this.overflow();
      this.emit(this.buf.slice(start, i));
      start = i + 1;
      this.scanned = start;
    }
    if (this.dead) return;
    this.buf = this.buf.slice(start);
    this.scanned = this.buf.length;
    if (this.buf.length > this.opts.maxRecordChars) this.overflow();
  }

  private emit(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length > 0) this.opts.onLine(line);
  }

  private overflow(): void {
    this.dead = true;
    this.buf = "";
    this.scanned = 0;
    this.opts.onOverflow();
  }
}

/** A decoded JSON object from the child; its fields are untrusted until narrowed. */
export type JsonRecord = Record<string, unknown>;

export interface RpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  error?: string;
  data?: JsonRecord;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Spawn failure (e.g. ENOENT); the process never ran. */
  spawnError?: Error;
}

export interface RpcOptions {
  onEvent(event: JsonRecord): void;
  /** Malformed record, overflow, or a throwing onEvent. Reported, never thrown. */
  onProtocolError(err: Error): void;
  /** Called once, before pending requests are rejected. */
  onExit?(info: ExitInfo): void;
  maxRecordChars?: number;
  maxPending?: number;
  stderrTailBytes?: number;
  /** After "exit", how long to wait for stdio "close" so stdout is fully drained. */
  drainMs?: number;
}

interface Pending {
  resolve(r: RpcResponse): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcConnection {
  /** Resolves exactly once when the child is gone and stdio is released. */
  readonly exited: Promise<ExitInfo>;
  private readonly pending = new Map<string, Pending>();
  private readonly framer: JsonlFramer;
  private stderrBuf: Buffer = Buffer.alloc(0);
  private nextId = 0;
  private stdinOk = true;
  private done = false;
  private resolveExit!: (i: ExitInfo) => void;
  private exitInfo: ExitInfo | undefined;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly opts: RpcOptions,
  ) {
    this.exited = new Promise((r) => (this.resolveExit = r));
    this.framer = new JsonlFramer({
      maxRecordChars: opts.maxRecordChars ?? 16 * 1024 * 1024,
      onLine: (l) => this.onLine(l),
      onOverflow: () => this.opts.onProtocolError(new RpcError("protocol", "record exceeded size limit")),
    });
    const { stdin, stdout, stderr } = child;
    // Always drain; stream errors are protocol faults, not silent.
    stdout?.on("data", this.onStdout);
    stdout?.on("error", this.onStreamError);
    stderr?.on("data", this.onStderr);
    stderr?.on("error", this.onStreamError);
    stdin?.on("error", this.onStdinError);
    if (!stdin || !stdout || !stderr) this.stdinOk = false;
    child.once("error", this.onSpawnError);
    child.once("exit", this.onExit);
    child.once("close", this.onClose);
  }

  /** Last stderr bytes (bounded), decoded lossy. */
  stderrTail(): string {
    return this.stderrBuf.toString("utf8");
  }

  send(command: Record<string, unknown>, timeoutMs: number): Promise<RpcResponse> {
    if (this.done) return Promise.reject(new RpcError("exit", "child exited"));
    if (!this.stdinOk) return Promise.reject(new RpcError("stdin", "stdin unavailable"));
    if (this.pending.size >= (this.opts.maxPending ?? 64)) {
      return Promise.reject(new RpcError("busy", "too many pending requests"));
    }
    const id = `r${++this.nextId}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError("timeout", `no response to ${String(command.type)} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...command, id }, (e) => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(e);
        }
      });
    });
  }

  /** Fire-and-forget write (e.g. extension_ui_response). Failures mark stdin broken; exit handling reports. */
  sendNoReply(msg: Record<string, unknown>): void {
    if (this.done || !this.stdinOk) return;
    this.write(msg, () => {});
  }

  closeInput(): void {
    if (!this.stdinOk) return;
    this.stdinOk = false;
    try {
      this.child.stdin?.end();
    } catch {
      // already destroyed: input is closed either way
    }
  }

  private write(msg: Record<string, unknown>, onFail: (e: Error) => void): void {
    try {
      this.child.stdin!.write(JSON.stringify(msg) + "\n", (err) => {
        if (err) {
          this.stdinOk = false;
          onFail(new RpcError("stdin", `stdin write failed: ${err.message}`));
        }
      });
    } catch (e) {
      this.stdinOk = false;
      onFail(new RpcError("stdin", `stdin write threw: ${(e as Error).message}`));
    }
  }

  private onLine(line: string): void {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      this.opts.onProtocolError(new RpcError("protocol", `malformed JSON record: ${(e as Error).message}`));
      return;
    }
    if (rec === null || typeof rec !== "object" || Array.isArray(rec) || typeof (rec as JsonRecord).type !== "string") {
      this.opts.onProtocolError(new RpcError("protocol", "record is not an object with a string type"));
      return;
    }
    const msg = rec as JsonRecord;
    if (msg.type === "response") {
      const id = msg.id;
      const p = typeof id === "string" ? this.pending.get(id) : undefined;
      if (p && typeof id === "string") {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve(msg as unknown as RpcResponse);
      } else if (msg.success === false) {
        // e.g. a parse-error response with no id: we sent something the child rejected
        this.opts.onProtocolError(new RpcError("protocol", `unmatched error response: ${String(msg.error)}`));
      }
      return;
    }
    try {
      this.opts.onEvent(msg);
    } catch (e) {
      this.opts.onProtocolError(new RpcError("protocol", `event handler threw: ${(e as Error).message}`));
    }
  }

  private readonly onStdout = (c: Buffer | string): void => this.framer.push(c);

  private readonly onStderr = (c: Buffer | string): void => {
    const max = this.opts.stderrTailBytes ?? 4096;
    const b = typeof c === "string" ? Buffer.from(c) : c;
    // Bound before concat so a huge chunk cannot inflate memory beyond itself
    this.stderrBuf = Buffer.concat([this.stderrBuf, b.length > max ? b.subarray(b.length - max) : b]);
    if (this.stderrBuf.length > max) this.stderrBuf = this.stderrBuf.subarray(this.stderrBuf.length - max);
  };

  private readonly onStreamError = (e: Error): void => {
    this.opts.onProtocolError(new RpcError("protocol", `stdio error: ${e.message}`));
  };

  private readonly onStdinError = (e: Error): void => {
    // EPIPE etc: child is closing; pending writes fail via callbacks, exit is reported separately
    this.stdinOk = false;
    this.failPending(new RpcError("stdin", `stdin error: ${e.message}`));
  };

  private readonly onSpawnError = (e: Error): void => {
    // "error" also fires for failed kill/send on a live child; only a pid-less child never started
    if (this.child.pid !== undefined) {
      this.opts.onProtocolError(new RpcError("protocol", `child error: ${e.message}`));
      return;
    }
    this.finish({ code: null, signal: null, spawnError: e });
  };

  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.exitInfo = { code, signal };
    // grandchildren may hold the pipes open; do not wait forever for "close"
    this.drainTimer = setTimeout(() => this.finish(this.exitInfo!), this.opts.drainMs ?? 250);
  };

  private readonly onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.finish(this.exitInfo ?? { code, signal });
  };

  private finish(info: ExitInfo): void {
    if (this.done) return;
    this.done = true;
    this.stdinOk = false;
    clearTimeout(this.drainTimer);
    this.framer.end();
    const { stdin, stdout, stderr } = this.child;
    stdout?.off("data", this.onStdout);
    stderr?.off("data", this.onStderr);
    // keep no-op-safe error listeners so late stream errors cannot crash the process
    stdout?.on("error", () => {});
    stderr?.on("error", () => {});
    stdin?.on("error", () => {});
    stdout?.destroy();
    stderr?.destroy();
    stdin?.destroy();
    this.child.off("error", this.onSpawnError);
    this.child.off("exit", this.onExit);
    this.child.off("close", this.onClose);
    try {
      this.opts.onExit?.(info);
    } catch (e) {
      this.opts.onProtocolError(new RpcError("protocol", `exit handler threw: ${(e as Error).message}`));
    }
    this.failPending(new RpcError("exit", "child exited before responding"));
    this.resolveExit(info);
  }

  private failPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
  }
}
