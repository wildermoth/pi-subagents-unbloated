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
