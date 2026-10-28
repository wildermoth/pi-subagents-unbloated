import { describe, expect, test } from "bun:test";
import { createInbox } from "../src/inbox.ts";
import type { JobRecord } from "../src/jobs.ts";

const rec = (id: string, over: Partial<JobRecord> = {}): JobRecord => ({
  id, agent: "scout", task: "t", state: "completed", createdAt: 1, delivered: false,
  result: { status: "completed", text: `out-${id}`, truncated: false }, ...over,
});

describe("inbox delivery", () => {
  test("two jobs in one turn: one wakeup signal drains both", () => {
    let wakes = 0;
    const ib = createInbox({ onPublish: () => wakes++ });
    ib.publish(rec("A"));
    ib.publish(rec("B"));
    expect(ib.size).toBe(2);
    const got = ib.drain();
    expect(got.map((r) => r.id)).toEqual(["A", "B"]);
    expect(got.every((r) => r.delivered)).toBe(true);
    expect(ib.size).toBe(0);
    expect(ib.drain()).toEqual([]);
    expect(wakes).toBe(2); // caller coalesces wakes
  });

  test("take mid-turn: B never reappears", () => {
    const ib = createInbox();
    const a = rec("A"), b = rec("B");
    ib.publish(a);
    ib.publish(b);
    expect(ib.take("B")).toBe(b);
    expect(b.delivered).toBe(true);
    expect(a.delivered).toBe(false);
    expect(ib.drain()).toEqual([a]);
    expect(ib.drain()).toEqual([]);
    ib.publish(b);
    expect(ib.size).toBe(0);
    expect(ib.take("B")).toBeUndefined();
    expect(ib.drain()).toEqual([]);
  });

  test("unread mid-turn arrival yields exactly one later delivery", () => {
    const ib = createInbox();
    ib.publish(rec("A"));
    expect(ib.drain().length).toBe(1);
    ib.publish(rec("B")); // late arrival during turn
    expect(ib.size).toBe(1);
    expect(ib.drain().map((r) => r.id)).toEqual(["B"]);
    expect(ib.size).toBe(0);
  });

  test("duplicate publish ignored and does not signal; delivered never replayed", () => {
    let wakes = 0;
    const ib = createInbox({ onPublish: () => wakes++ });
    const a = rec("A");
    ib.publish(a);
    ib.publish(rec("A"));
    expect(wakes).toBe(1);
    expect(ib.size).toBe(1);
    ib.drain();
    ib.publish(a);
    expect(ib.size).toBe(0);
    expect(wakes).toBe(1);
  });

  test("take of unknown id is undefined", () => {
    expect(createInbox().take("x")).toBeUndefined();
  });
});

describe("inbox format", () => {
  test("header, per-record lines, failure kind and message", () => {
    const ib = createInbox();
    const out = ib.format([
      rec("A"),
      rec("B", { state: "failed", result: { status: "failed", text: "", truncated: false, failure: { kind: "timeout", message: "too slow" } } }),
      rec("C", { state: "cancelled", result: undefined }),
    ]);
    expect(out.split("\n")[0]).toBe("3 subagent jobs finished");
    expect(out).toContain("[A scout] completed\nout-A");
    expect(out).toContain("[B scout] failed (timeout)\nerror: too slow");
    expect(out).toContain("[C scout] cancelled");
    expect(createInbox().format([rec("A")]).split("\n")[0]).toBe("1 subagent job finished");
  });

  test("truncation is explicit and utf-8 safe", () => {
    const ib = createInbox({ maxTextBytes: 10 });
    const text = "ab" + "€".repeat(5); // 2 + 15 bytes
    const out = ib.format([rec("A", { result: { status: "completed", text, truncated: false } })]);
    expect(out).toContain("ab€€\n");
    expect(out).not.toContain("�");
    expect(out).toContain("[truncated: showing 8 of 17 bytes]");
  });

  test("runner truncation flagged; short text has no marker", () => {
    const ib = createInbox();
    expect(ib.format([rec("A", { result: { status: "completed", text: "x", truncated: true } })])).toContain("[truncated by runner]");
    expect(ib.format([rec("A")])).not.toContain("truncated");
  });
});
