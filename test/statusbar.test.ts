import { describe, expect, test } from "bun:test";
import type { JobRecord } from "../src/jobs.ts";
import { activity, clip, elapsed, FRAMES, plain, renderStatus, tokens, type RenderOptions } from "../src/statusbar.ts";
import type { Progress } from "../src/types.ts";

const progress = (o: Partial<Progress> = {}): Progress => ({ turns: 0, tools: 0, tokens: 0, active: [], text: "", ...o });
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
  now: 13_300,
  frame: 2,
  width: 200,
  style: plain,
  fit: (l, w) => l.slice(0, w),
  ...o,
});
const done = (text = "all done") => ({ status: "completed" as const, text, truncated: false });
const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
const tagged = { accent: tag("a"), dim: tag("d"), success: tag("s"), warn: tag("w"), error: tag("e"), bold: tag("b") };

describe("renderStatus", () => {
  test("nothing live, queued or unread clears the widget", () => {
    expect(renderStatus([], opts())).toBeUndefined();
    expect(renderStatus([rec("1", "completed", { delivered: true, endedAt: 2000 }), rec("2", "interrupted")], opts())).toBeUndefined();
  });

  test("running rows show turns, tool uses, tokens with context use, elapsed time and what the agent is doing", () => {
    const lines = renderStatus(
      [
        rec("1", "running", {
          contextWindow: 54_000,
          progress: progress({ turns: 5, tools: 5, tokens: 33_800, active: ["edit", "edit"] }),
        }),
        rec("2", "running", { contextWindow: 150_000, progress: progress({ turns: 3, tools: 1, tokens: 12_400, active: ["grep"] }) }),
        rec("q1", "queued"),
        rec("q2", "queued"),
      ],
      opts(),
    );
    expect(lines).toEqual([
      "● Agents",
      `├─ ${FRAMES[2]} agent-1  task 1 · ↻ 5 · 5 tool uses · 33.8k token (63%) · 12.3s`,
      "│      ⎿  editing 2 files…",
      `├─ ${FRAMES[2]} agent-2  task 2 · ↻ 3 · 1 tool use · 12.4k token (8%) · 12.3s`,
      "│      ⎿  searching…",
      "└─ 2 queued",
    ]);
  });

  test("a row without progress yet shows zeros and 'thinking…', never a missing field", () => {
    expect(renderStatus([rec("1", "running")], opts())).toEqual([
      "● Agents",
      `└─ ${FRAMES[2]} agent-1  task 1 · ↻ 0 · 0 tool uses · 0 token · 12.3s`,
      "       ⎿  thinking…",
    ]);
  });

  test("finished rows keep their stats but drop the context percentage and the activity line", () => {
    const lines = renderStatus(
      [
        rec("1", "completed", {
          endedAt: 4100,
          contextWindow: 1000,
          progress: progress({ turns: 4, tools: 7, tokens: 900 }),
          result: done(),
        }),
        rec("2", "failed", {
          endedAt: 2000,
          result: { status: "failed", text: "", truncated: false, failure: { kind: "exit", message: "Pi exited" } },
        }),
        rec("3", "cancelled", { endedAt: 3000 }),
      ],
      opts(),
    );
    expect(lines).toEqual([
      "○ Agents",
      "├─ ✓ agent-1  task 1 · ↻ 4 · 7 tool uses · 900 token · 3.1s",
      "├─ ✗ agent-2  task 2 · ↻ 0 · 0 tool uses · 0 token · 1.0s error: Pi exited",
      "└─ ■ agent-3  task 3 · ↻ 0 · 0 tool uses · 0 token · 2.0s",
    ]);
  });

  test("context use is dim below 70%, warning from 70%, error from 85%", () => {
    const at = (t: number) =>
      renderStatus([rec("1", "running", { contextWindow: 100, progress: progress({ tokens: t }) })], opts({ style: tagged }))![1]!;
    expect(at(69)).toContain("<d>69%</d>");
    expect(at(70)).toContain("<w>70%</w>");
    expect(at(85)).toContain("<e>85%</e>");
  });

  test("no context percentage without a known context window", () => {
    const line = renderStatus([rec("1", "running", { progress: progress({ tokens: 5000 }) })], opts())![1]!;
    expect(line).toContain("5.0k token ·");
    expect(line).not.toContain("%");
  });

  test("the last row closes the tree with no rail on its activity line", () => {
    const lines = renderStatus([rec("1", "running", { progress: progress({ active: ["bash"] }) })], opts())!;
    expect(lines.at(-1)).toBe("       ⎿  running…");
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
    expect(lines.at(-1)).toBe("└─ +2 more, 2 queued");
  });

  test("only queued jobs still show a summary row", () => {
    expect(renderStatus([rec("1", "queued")], opts())).toEqual(["● Agents", "└─ 1 queued"]);
  });

  test("every line is fitted to the width", () => {
    const lines = renderStatus([rec("1", "running", { progress: progress({ text: "x".repeat(300) }) })], opts({ width: 20 }))!;
    expect(lines.every((l) => l.length <= 20)).toBe(true);
  });
});

describe("activity", () => {
  test("names the tools running now, grouping repeats", () => {
    expect(activity(progress({ active: ["read"] }))).toBe("reading…");
    expect(activity(progress({ active: ["read", "grep", "read"] }))).toBe("reading 2 files, searching…");
    expect(activity(progress({ active: ["web_search", "mystery"] }))).toBe("searching the web, using mystery…");
  });
  test("with no tool running it shows the end of the latest line, so streaming text keeps moving", () => {
    expect(activity(progress({ text: "first line\n  Found the bug in auth.ts  \n\n" }))).toBe("Found the bug in auth.ts");
    expect(activity(progress({ text: "short" }))).toBe("short");
    const long = `${"a".repeat(100)}END`;
    expect(activity(progress({ text: long }))).toBe(`…${"a".repeat(56)}END`);
    expect([...activity(progress({ text: long }))]).toHaveLength(60);
    expect(activity(progress())).toBe("thinking…");
    expect(activity(undefined)).toBe("thinking…");
  });
});

describe("formatting", () => {
  test("clip collapses whitespace and ends with an ellipsis at the limit", () => {
    expect(clip("a\n\n  b\tc", 80)).toBe("a b c");
    const out = clip("x".repeat(200), 80);
    expect([...out]).toHaveLength(80);
    expect(out.endsWith("…")).toBe(true);
  });
  test("elapsed switches to minutes", () => {
    expect(elapsed(14_200)).toBe("14.2s");
    expect(elapsed(137_000)).toBe("2m17s");
    expect(elapsed(125_000)).toBe("2m05s");
    expect(elapsed(-5)).toBe("0.0s");
  });
  test("tokens abbreviates thousands and millions", () => {
    expect([tokens(950), tokens(33_800), tokens(1_250_000)]).toEqual(["950", "33.8k", "1.3M"]);
  });
});
