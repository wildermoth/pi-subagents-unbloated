/** Turns the event stream both backends emit into a small progress snapshot for display. Same event shapes for RPC and SDK. */
import { assistantText, asRecord } from "./outcome.ts";
import type { JsonRecord } from "./protocol.ts";
import type { Progress } from "./types.ts";

/** Returns a function to feed every event to. `onChange` gets a fresh snapshot whenever something visible changed. */
export function createTracker(onChange: ((p: Progress) => void) | undefined): (ev: JsonRecord) => void {
  if (!onChange) return () => {};
  const p: Progress = { turns: 0, tools: 0, tokens: 0, active: [], text: "" };
  const running = new Map<string, string>(); // toolCallId -> tool name
  const emit = () => {
    p.active = [...running.values()];
    try {
      onChange({ ...p });
    } catch {
      // a display observer must never fail the run
    }
  };
  return (ev) => {
    switch (ev.type) {
      case "message_end": {
        const m = asRecord(ev.message);
        if (m?.role !== "assistant") return;
        p.turns++;
        p.text = assistantText(m);
        const total = asRecord(m.usage)?.totalTokens;
        if (typeof total === "number") p.tokens = total; // context size after this turn, not a running sum
        return emit();
      }
      case "tool_execution_start":
        p.tools++;
        running.set(String(ev.toolCallId), String(ev.toolName));
        return emit();
      case "tool_execution_end":
        if (running.delete(String(ev.toolCallId))) emit();
    }
  };
}
