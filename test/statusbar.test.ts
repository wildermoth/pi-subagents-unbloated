import { describe, expect, test } from "bun:test";
import type { JobRecord } from "../src/jobs.ts";
import { clip, renderStatus } from "../src/statusbar.ts";

const rec = (id: string, state: JobRecord["state"], o: Partial<JobRecord> = {}): JobRecord => ({
  id,
  agent: `agent-${id}`,
  task: `task ${id}`,
  state,
  createdAt: 0,
  delivered: false,
  ...o,
});

describe("renderStatus", () => {
  test("nothing live or unread clears the widget", () => {
    expect(renderStatus([])).toBeUndefined();
    expect(renderStatus([rec("1", "completed", { delivered: true }), rec("2", "interrupted")])).toBeUndefined();
  });

  test("live jobs first, then finished unread, as 'state | agent: text'", () => {
    const lines = renderStatus([
      rec("1", "completed", { result: { status: "completed", text: "all done", truncated: false } }),
      rec("2", "running", { activity: "searching" }),
      rec("3", "queued"),
    ]);
    expect(lines).toEqual(["running | agent-2: searching", "queued | agent-3: task 3", "completed | agent-1: all done"]);
  });

  test("failed jobs show the failure message", () => {
    const lines = renderStatus([
      rec("1", "failed", { result: { status: "failed", text: "", truncated: false, failure: { kind: "exit", message: "Pi exited" } } }),
    ]);
    expect(lines).toEqual(["failed | agent-1: Pi exited"]);
  });

  test("caps at five lines and counts the hidden rest", () => {
    const lines = renderStatus([1, 2, 3, 4, 5, 6, 7].map((i) => rec(String(i), "running")))!;
    expect(lines.length).toBe(6);
    expect(lines.at(-1)).toBe("+2 more");
  });

  test("exactly five shows no counter", () => {
    expect(renderStatus([1, 2, 3, 4, 5].map((i) => rec(String(i), "running")))!.length).toBe(5);
  });
});

describe("clip", () => {
  test("collapses whitespace and clips to 80 chars with an ellipsis", () => {
    expect(clip("a\n\n  b\tc")).toBe("a b c");
    const out = clip("x".repeat(200));
    expect([...out].length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });
});
