/** Result shaping shared by both backends: bounded text, and the mapping from a last assistant message to a RunResult. */
import type { JsonRecord } from "./protocol.ts";
import type { RunResult } from "./types.ts";

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, truncated: false };
  let cut = max;
  let marker: string;
  for (;;) {
    marker = `\n[truncated: ${buf.length - cut} of ${buf.length} bytes omitted]`;
    if (Buffer.byteLength(marker) > max) return { text: "[truncated]".slice(0, max), truncated: true };
    const next = Math.max(0, max - Buffer.byteLength(marker));
    if (cut <= next) break;
    cut = next;
    while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--; // do not split a UTF-8 sequence
  }
  return { text: buf.subarray(0, cut).toString("utf8") + marker, truncated: true };
}

/** Narrow an untrusted decoded value to an object, or undefined. */
export const asRecord = (v: unknown): JsonRecord | undefined => (v !== null && typeof v === "object" ? (v as JsonRecord) : undefined);

export function assistantText(msg: JsonRecord): string {
  const { content } = msg;
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map(asRecord)
    .filter((b): b is JsonRecord => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/** Whatever the child had said so far, so a cut-short run does not look like doing nothing. */
export const partialOf = (msg: JsonRecord | undefined, max: number): { text: string; truncated: boolean } =>
  msg ? truncate(assistantText(msg), max) : { text: "", truncated: false };

/** The result once the agent has settled, judged by its last assistant message. */
export function settledOutcome(msg: JsonRecord | undefined, max: number): RunResult {
  const failed = (kind: "provider" | "protocol", message: string): RunResult => ({
    status: "failed",
    ...partialOf(msg, max),
    failure: { kind, message },
  });
  if (!msg) return failed("protocol", "agent_settled without an assistant message");
  const stop = msg.stopReason;
  if (stop === "error") return failed("provider", typeof msg.errorMessage === "string" ? msg.errorMessage : "provider error");
  if (stop === "aborted") return failed("provider", "run aborted unexpectedly");
  if (stop === "length") return failed("provider", "model hit its output length limit; the result is partial");
  if (stop !== "stop") return failed("protocol", `unexpected stopReason: ${String(stop)}`);
  const t = truncate(assistantText(msg), max);
  return { status: "completed", text: t.text, truncated: t.truncated };
}
