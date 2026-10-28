import { describe, expect, test } from "bun:test";
import type { JobRecord } from "../src/jobs.ts";
import { clip, elapsed, FRAMES, plain, renderStatus, type RenderOptions } from "../src/statusbar.ts";

const rec = (id: string, state: JobRecord["state"], o: Partial<JobRecord> = {}): JobRecord => ({
  id,
  agent: `agent-${id}`,
  task: `task ${id}`,
  state,
  createdAt: 1000,
  startedAt: 1000,
  delivered: false,
  ...o,
});
const opts = (o: Partial<RenderOptions> = {}): RenderOptions => ({
  now: 15_200,
  frame: 2,
  width: 200,
  style: plain,
  fit: (l, w) => l.slice(0, w),
  ...o,
});
const done = (text = "all done") => ({ status: "completed" as const, text, truncated: false });

describe("renderStatus", () => {
  test("nothing live, queued or unread clears the widget", () => {
    expect(renderStatus([], opts())).toBeUndefined();
    expect(renderStatus([rec("1", "completed", { delivered: true, endedAt: 2000 }), rec("2", "interrupted")], opts())).toBeUndefined();
  });

  test("draws a tree: spinner and elapsed time for running, an activity line, a tick for finished", () => {
    const lines = renderStatus(
      [
        rec("1", "running", { activity: "searching the\nweb" }),
        rec("2", "completed", { endedAt: 4100, result: done() }),
        rec("3", "failed", {
          endedAt: 2000,
          result: { status: "failed", text: "", truncated: false, failure: { kind: "exit", message: "Pi exited" } },
        }),
        rec("4", "cancelled", { endedAt: 3000 }),
      ],
      opts(),
    );
    expect(lines).toEqual([
      "● Agents",
      `├─ ${FRAMES[2]} agent-1  task 1 · 14.2s`,
      "│      ⎿  searching the web",
      "├─ ✓ agent-2  task 2 · 3.1s",
      "├─ ✗ agent-3  task 3 · 1.0s error: Pi exited",
      "└─ ■ agent-4  task 4 · 2.0s",
    ]);
  });

  test("the last row closes the tree and its activity line has no rail", () => {
    const lines = renderStatus([rec("1", "running", { activity: "thinking" })], opts())!;
    expect(lines).toEqual(["● Agents", `└─ ${FRAMES[2]} agent-1  task 1 · 14.2s`, "       ⎿  thinking"]);
  });

  test("the spinner advances with the frame", () => {
    const at = (frame: number) => renderStatus([rec("1", "running")], opts({ frame }))![1]!;
    expect(at(0)).not.toBe(at(1));
    expect(at(FRAMES.length)).toBe(at(0));
  });

  test("caps at five rows, then counts the hidden rest and the queued", () => {
    const records = [...[1, 2, 3, 4, 5, 6, 7].map((i) => rec(String(i), "running")), rec("q1", "queued"), rec("q2", "queued")];
    const lines = renderStatus(records, opts())!;
    expect(lines.filter((l) => l.includes("agent-"))).toHaveLength(5);
    expect(lines.at(-1)).toBe("└─ ◦ +2 more, 2 queued");
  });

  test("only queued jobs still show a summary row", () => {
    expect(renderStatus([rec("1", "queued")], opts())).toEqual(["● Agents", "└─ ◦ 1 queued"]);
  });

  test("only finished jobs use the hollow heading", () => {
    expect(renderStatus([rec("1", "completed", { endedAt: 2000, result: done() })], opts())![0]).toBe("○ Agents");
  });

  test("every line is fitted to the width", () => {
    const lines = renderStatus([rec("1", "running", { activity: "x".repeat(300) })], opts({ width: 20 }))!;
    expect(lines.every((l) => l.length <= 20)).toBe(true);
  });

  test("styles are applied through the style hooks", () => {
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const style = { accent: tag("a"), dim: tag("d"), success: tag("s"), error: tag("e"), bold: tag("b") };
    const lines = renderStatus([rec("1", "completed", { endedAt: 2000, result: done() })], opts({ style }))!;
    expect(lines[1]).toContain("<s>✓</s> <b>agent-1</b>");
  });
});

describe("clip and elapsed", () => {
  test("clip collapses whitespace and ends with an ellipsis at the limit", () => {
    expect(clip("a\n\n  b\tc", 80)).toBe("a b c");
    const out = clip("x".repeat(200), 80);
    expect([...out]).toHaveLength(80);
    expect(out.endsWith("…")).toBe(true);
  });
  test("elapsed switches to minutes", () => {
    expect(elapsed(14_200)).toBe("14.2s");
    expect(elapsed(125_000)).toBe("2m 05s");
    expect(elapsed(-5)).toBe("0.0s");
  });
});
