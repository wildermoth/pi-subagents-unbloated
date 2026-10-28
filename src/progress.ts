/** Turns the event stream both backends emit into a small progress snapshot for display. Same event shapes for RPC and SDK. */
import { asRecord, assistantText } from "./outcome.ts";
import type { JsonRecord } from "./protocol.ts";
import type { Progress } from "./types.ts";

/** Rough characters per token, only used to move the count while a message streams in. */
const CHARS_PER_TOKEN = 4;

/** Returns a function to feed every event to. `onChange` gets a fresh snapshot whenever something visible changed. */
export function createTracker(onChange: ((p: Progress) => void) | undefined): (ev: JsonRecord) => void {
  if (!onChange) return () => {};
  const p: Progress = { turns: 0, tools: 0, tokens: 0, active: [], text: "" };
  const running = new Map<string, string>(); // toolCallId -> tool name
  const counted = new Set<string>(); // tool calls already counted, whether seen streaming or executing
  let base = 0; // context size at the last finished message; the estimate builds on it
  let streamed = 0; // characters streamed in the current message

  const emit = () => {
    p.active = [...running.values()];
    try {
      onChange({ ...p });
    } catch {
      // a display observer must never fail the run
    }
  };
  const count = (id: unknown) => {
    if (typeof id !== "string" || counted.has(id)) return;
    counted.add(id);
    p.tools++;
  };

  /** A streaming update: move the token estimate, show the live text, and count tool calls as they begin. */
  function onUpdate(ev: JsonRecord) {
    const e = asRecord(ev.assistantMessageEvent);
    const partial = asRecord(e?.partial);
    if (!e || !partial) return;
    if (typeof e.delta === "string") {
      streamed += e.delta.length;
      p.tokens = base + Math.ceil(streamed / CHARS_PER_TOKEN);
    }
    if (e.type === "toolcall_start" && typeof e.contentIndex === "number") {
      const call = asRecord(Array.isArray(partial.content) ? (partial.content as unknown[])[e.contentIndex] : undefined);
      count(call?.id);
    }
    p.text = assistantText(partial);
    emit();
  }

  return (ev) => {
    switch (ev.type) {
      case "turn_start": // counted as it begins, so a long first turn already reads as turn 1
        p.turns++;
        p.text = "";
        streamed = 0;
        return emit();
      case "message_update":
        return onUpdate(ev);
      case "message_end": {
        const m = asRecord(ev.message);
        if (m?.role !== "assistant") return;
        p.text = assistantText(m);
        const total = asRecord(m.usage)?.totalTokens;
        if (typeof total === "number") p.tokens = total; // the provider's figure replaces the estimate
        base = p.tokens;
        streamed = 0;
        return emit();
      }
      case "tool_execution_start":
        count(ev.toolCallId);
        running.set(String(ev.toolCallId), String(ev.toolName));
        return emit();
      case "tool_execution_end":
        if (running.delete(String(ev.toolCallId))) emit();
    }
  };
}
