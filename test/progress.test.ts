import { expect, test } from "bun:test";
import { createTracker } from "../src/progress.ts";
import type { Progress } from "../src/types.ts";

const assistant = (text: string, totalTokens?: number) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], ...(totalTokens === undefined ? {} : { usage: { totalTokens } }) },
});

function track() {
  const seen: Progress[] = [];
  return { seen, feed: createTracker((p) => seen.push(p)) };
}

test("counts a turn as it starts, takes context size from the latest usage, and keeps the latest text", () => {
  const { seen, feed } = track();
  feed({ type: "turn_start" });
  expect(seen.at(-1)).toEqual({ turns: 1, tools: 0, tokens: 0, active: [], text: "" }); // visible before the turn finishes
  feed(assistant("one", 100));
  feed({ type: "turn_start" });
  feed(assistant("two", 250));
  expect(seen.at(-1)).toEqual({ turns: 2, tools: 0, tokens: 250, active: [], text: "two" });
});

test("a message without usage keeps the previous token count", () => {
  const { seen, feed } = track();
  feed(assistant("one", 100));
  feed(assistant("two"));
  expect(seen.at(-1)!.tokens).toBe(100);
});

test("tracks overlapping tool calls by id and counts every start", () => {
  const { seen, feed } = track();
  feed({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  feed({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
  expect(seen.at(-1)).toMatchObject({ tools: 2, active: ["read", "read"] });
  feed({ type: "tool_execution_end", toolCallId: "a", toolName: "read" });
  expect(seen.at(-1)).toMatchObject({ tools: 2, active: ["read"] });
});

test("ignores other events, other roles, and unknown tool ends", () => {
  const { seen, feed } = track();
  feed({ type: "agent_start" });
  feed({ type: "message_end", message: { role: "user", content: "hi" } });
  feed({ type: "tool_execution_end", toolCallId: "never-started", toolName: "read" });
  expect(seen).toEqual([]);
});

test("snapshots are independent copies, and a throwing observer is swallowed", () => {
  const { seen, feed } = track();
  feed({ type: "tool_execution_start", toolCallId: "a", toolName: "grep" });
  feed({ type: "tool_execution_end", toolCallId: "a", toolName: "grep" });
  expect(seen[0]!.active).toEqual(["grep"]);
  const bad = createTracker(() => {
    throw new Error("display bug");
  });
  expect(() => bad(assistant("x", 1))).not.toThrow();
});

test("without an observer the tracker does nothing", () => {
  expect(() => createTracker(undefined)(assistant("x", 1))).not.toThrow();
});

const update = (delta: object, partial: object) => ({ type: "message_update", assistantMessageEvent: { ...delta, partial } });
const partialText = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

test("streamed deltas move the token estimate and show live text, then the provider's figure replaces the estimate", () => {
  const { seen, feed } = track();
  feed({ type: "turn_start" });
  feed(assistant("first", 100)); // context is now 100 tokens
  feed({ type: "turn_start" });
  feed(update({ type: "text_delta", delta: "x".repeat(40) }, partialText("x".repeat(40))));
  expect(seen.at(-1)).toMatchObject({ tokens: 110, text: "x".repeat(40) }); // 100 + 40 chars / 4
  feed(update({ type: "thinking_delta", delta: "y".repeat(20) }, partialText("x".repeat(40))));
  expect(seen.at(-1)!.tokens).toBe(115); // thinking counts too
  feed(assistant("done", 130));
  expect(seen.at(-1)!.tokens).toBe(130);
});

test("a new turn starts with no text, so the activity line says thinking until text streams in", () => {
  const { seen, feed } = track();
  feed(assistant("old answer", 50));
  feed({ type: "turn_start" });
  expect(seen.at(-1)!.text).toBe("");
});

test("a tool call counts as soon as it starts streaming, and executing it does not count it twice", () => {
  const { seen, feed } = track();
  const call = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] };
  feed(update({ type: "toolcall_start", contentIndex: 0 }, call));
  expect(seen.at(-1)).toMatchObject({ tools: 1, active: [] }); // counted, not yet running
  feed({ type: "tool_execution_start", toolCallId: "c1", toolName: "read" });
  expect(seen.at(-1)).toMatchObject({ tools: 1, active: ["read"] });
});

test("a tool call whose id is unknown while streaming is counted when it executes", () => {
  const { seen, feed } = track();
  feed(update({ type: "toolcall_start", contentIndex: 0 }, { role: "assistant", content: [{ type: "toolCall", name: "read" }] }));
  expect(seen.at(-1)!.tools).toBe(0);
  feed({ type: "tool_execution_start", toolCallId: "c9", toolName: "read" });
  expect(seen.at(-1)!.tools).toBe(1);
});

test("malformed update events are ignored", () => {
  const { seen, feed } = track();
  feed({ type: "message_update" });
  feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
  expect(seen).toEqual([]);
});
