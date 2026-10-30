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
  test("clears when there are no active or unread jobs", () => {
    expect(renderStatus([], opts())).toBeUndefined();
    expect(renderStatus([rec("1", "completed", { delivered: true }), rec("2", "interrupted")], opts())).toBeUndefined();
  });

  test("shows main and one compact row per agent, with right-aligned telemetry", () => {
    const lines = renderStatus(
      [
        rec("1", "running", { contextWindow: 54_000, progress: progress({ tokens: 33_800, active: ["edit", "edit"] }) }),
        rec("2", "running"),
      ],
      opts(),
    )!;
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("  ← 2 agents · ↓ to manage");
    expect(lines[1]).toBe("  ● main");
    expect(lines[2]).toContain(`${FRAMES[2]} agent-1  editing 2 files…`);
    expect(lines[2]).toEndWith("12.3s · ↓ 33.8k tokens (63%)");
    expect(lines[3]).toContain("thinking…");
    expect(lines[3]).toEndWith("12.3s · ↓ 0 tokens");
    expect(lines[2]).toHaveLength(200);
    expect(lines[3]).toHaveLength(200);
  });

  test("finished rows freeze time, show result or failure, and omit context percentage", () => {
    const lines = renderStatus(
      [
        rec("1", "completed", { endedAt: 4100, contextWindow: 1000, progress: progress({ tokens: 900 }), result: done() }),
        rec("2", "failed", {
          endedAt: 2000,
          result: { status: "failed", text: "", truncated: false, failure: { kind: "exit", message: "Pi exited" } },
        }),
        rec("3", "cancelled", { endedAt: 3000 }),
      ],
      opts(),
    )!;
    expect(lines[2]).toContain("✓ agent-1  all done");
    expect(lines[2]).toEndWith("3.1s · ↓ 900 tokens");
    expect(lines[2]).not.toContain("%");
    expect(lines[3]).toContain("✗ agent-2  error: Pi exited");
    expect(lines[4]).toContain("■ agent-3");
  });

  test("context use retains warning and error thresholds", () => {
    const at = (n: number) =>
      renderStatus([rec("1", "running", { contextWindow: 100, progress: progress({ tokens: n }) })], opts({ style: tagged }))![2]!;
    expect(at(69)).toContain("<d>69%</d>");
    expect(at(70)).toContain("<w>70%</w>");
    expect(at(85)).toContain("<e>85%</e>");
    expect(renderStatus([rec("1", "running", { progress: progress({ tokens: 5000 }) })], opts())![2]).not.toContain("%");
  });

  test("spinner advances and wraps", () => {
    const at = (frame: number) => renderStatus([rec("1", "running")], opts({ frame }))![2]!;
    expect(at(0)).not.toBe(at(1));
    expect(at(FRAMES.length)).toBe(at(0));
  });

  test("caps visible agents and includes overflow and queued counts", () => {
    const records = [...Array.from({ length: 7 }, (_, i) => rec(String(i), "running")), rec("q", "queued")];
    const lines = renderStatus(records, opts())!;
    expect(lines[0]).toContain("8 agents");
    expect(lines.filter((l) => l.includes("agent-"))).toHaveLength(5);
    expect(lines.at(-1)).toBe("  +2 more, 1 queued");
    expect(renderStatus([rec("q", "queued")], opts())!.at(-1)).toBe("  1 queued");
  });

  test("selection highlights only its row and replaces the passive hints", () => {
    const lines = renderStatus([rec("1", "running"), rec("2", "running")], opts({ selected: "2", hint: true }))!;
    expect(lines[0]).toBe("  ↑/↓ select · enter actions · esc return");
    expect(lines[2]).toStartWith("  ");
    expect(lines[3]).toStartWith("❯ ");
  });

  test("long activity cannot push telemetry off the right edge", () => {
    const lines = renderStatus([rec("1", "running", { progress: progress({ text: "x".repeat(300) }) })], opts({ width: 60 }))!;
    expect(lines[2]).toHaveLength(60);
    expect(lines[2]).toEndWith("12.3s · ↓ 0 tokens");
    const narrow = renderStatus([rec("1", "running")], opts({ width: 20 }))!;
    expect(narrow.every((l) => l.length <= 20)).toBe(true);
    expect(narrow[2]).toContain("agent-1");
  });

  test("alignment uses terminal columns, not ANSI string length", () => {
    const measure = (s: string) => [...s.replace(/<[^>]*>/g, "")].length;
    const lines = renderStatus([rec("1", "running")], opts({ style: tagged, width: 100, measure, fit: (s) => s }))!;
    expect(measure(lines[2]!)).toBe(100);
  });
});

describe("activity", () => {
  test("names the tools running now, grouping repeats", () => {
    expect(activity(progress({ active: ["read"] }))).toBe("reading…");
    expect(activity(progress({ active: ["read", "grep", "read"] }))).toBe("reading 2 files, searching…");
    expect(activity(progress({ active: ["bash", "mystery"] }))).toBe("running, using mystery…");
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
