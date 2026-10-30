import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Params } from "../src/schema.ts";
import { renderCall, renderResult } from "../src/tool-render.ts";

// Rendering needs only the theme's color function.
const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;

function context(args: Params, isError = false) {
  return { args, isError, state: {}, invalidate() {} };
}

test("background start becomes one launch line and omits task and acknowledgement", async () => {
  const args: Params = { action: "start", agent: "researcher", task: "a very long private task" };
  let redraw: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    redraw = resolve;
  });
  const ctx = {
    ...context(args),
    invalidate: () => {
      redraw();
      throw new Error("disposed");
    },
  };
  const call = renderCall(args, theme, ctx);
  expect(call.render(80)).toEqual([]);
  await ready;
  expect(call.render(80).map((line) => line.trimEnd())).toEqual(["Launching researcher"]);
  const result = renderResult(
    { content: [{ type: "text", text: "started j1 (researcher)" }] },
    { expanded: false, isPartial: false },
    theme,
    ctx,
  );
  expect(call.render(80).map((line) => line.trimEnd())).toEqual(["Launched researcher"]);
  expect(result.render(80)).toEqual([]);
});

test("errors and wait results remain visible", () => {
  for (const [wait, isError] of [
    [false, true],
    [true, false],
  ]) {
    const args: Params = { action: "start", agent: "worker", wait };
    const ctx = context(args, isError);
    const call = renderCall(args, theme, ctx);
    const result = renderResult({ content: [{ type: "text", text: "result detail" }] }, { expanded: false, isPartial: false }, theme, ctx);
    expect(result.render(80).map((line) => line.trimEnd())).toEqual(["result detail"]);
    expect(call.render(80).map((line) => line.trimEnd())).toEqual([`${isError ? "Subagent failed:" : "Launched"} worker`]);
  }
});

test("other actions preserve results and expand long output", () => {
  const ctx = context({ action: "status", id: "j1" });
  const result = { content: [{ type: "text", text: "1\n2\n3\n4\n5\n6" }] };
  expect(renderResult(result, { expanded: false, isPartial: false }, theme, ctx).render(80).join("\n")).toContain("1 more lines");
  expect(
    renderResult(result, { expanded: true, isPartial: false }, theme, ctx)
      .render(80)
      .map((line) => line.trimEnd()),
  ).toEqual(["1", "2", "3", "4", "5", "6"]);
});

test("width and terminal escape sequences are handled", () => {
  const args: Params = { action: "start", agent: "\u001b[31m研究員\u001b[0m", task: "task" };
  const lines = renderCall(args, theme, context(args)).render(8);
  expect(lines.every((line) => visibleWidth(line) <= 8)).toBe(true);
  expect(lines.join("")).not.toContain("\u001b");
});

test("incomplete and malformed streaming arguments do not throw", () => {
  const args = { action: "start", agent: 42 } as unknown as Params;
  const ctx = context(args);
  expect(
    renderCall(args, theme, ctx)
      .render(80)
      .map((line) => line.trimEnd()),
  ).toEqual(["Launching agent"]);
  const missing = undefined as unknown as Params;
  expect(
    renderCall(missing, theme, context(missing))
      .render(80)
      .map((line) => line.trimEnd()),
  ).toEqual(["Subagent subagent"]);
});
