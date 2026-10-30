import { expect, test } from "bun:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createAgentList } from "../src/agent-list.ts";
import type { JobRecord } from "../src/jobs.ts";

const LEFT = "\x1b[D";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ESC = "\x1b";
const ENTER = "\r";

const job = (id: string, state: JobRecord["state"], o: Partial<JobRecord> = {}): JobRecord => ({
  id,
  agent: `agent-${id}`,
  task: `task ${id}`,
  state,
  createdAt: 0,
  delivered: false,
  ...o,
});

/** A terminal stand-in plus a list wired to scriptable jobs and spies for each action. */
async function setup(jobs: JobRecord[], answers: (string | undefined)[] = [], text = "") {
  const calls = {
    redraws: 0,
    steer: [] as string[][],
    cancel: [] as string[],
    configure: [] as string[],
    notes: [] as string[],
    editor: [] as string[][],
  };
  let handler: ((d: string) => { consume?: boolean } | undefined) | undefined;
  let focused = true;
  const asked: { title: string; options: string[] }[] = [];
  let manager: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  let managerClosed = 0;
  const ui = {
    onTerminalInput: (h: typeof handler) => ((handler = h), () => (handler = undefined)),
    custom: (factory: (...args: unknown[]) => typeof manager) =>
      new Promise((resolve) => {
        manager = factory(
          { requestRender: () => void calls.redraws++, terminal: { rows: 24 } },
          { bold: (s: string) => s, fg: (_color: string, s: string) => s },
          {},
          (value: unknown) => {
            manager = undefined;
            managerClosed++;
            resolve(value);
          },
        );
      }),
    getEditorText: () => text,
    select: async (title: string, options: string[]) => (asked.push({ title, options }), answers.shift()),
    input: async () => answers.shift(),
    editor: async (title: string, body: string) => void calls.editor.push([title, body]),
    notify: (m: string) => void calls.notes.push(m),
  } as unknown as ExtensionUIContext;
  const list = createAgentList({
    records: () => jobs,
    redraw: () => void calls.redraws++,
    editorFocused: () => focused,
    steer: async (id, m) => void calls.steer.push([id, m]),
    cancel: async (id) => void calls.cancel.push(id),
    configure: async (a) => void calls.configure.push(a),
  });
  await list.bind(ui);
  const press = (k: string) => handler?.(k);
  return {
    list,
    press,
    calls,
    asked,
    manager: () => manager,
    managerClosed: () => managerClosed,
    setText: (t: string) => (text = t),
    setFocused: (f: boolean) => (focused = f),
    jobs,
  };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

test("Down at an empty prompt activates the list on the first agent and swallows the key", async () => {
  const t = await setup([job("1", "running"), job("2", "running")]);
  expect(t.press(DOWN)).toEqual({ consume: true });
  expect(t.list.active()).toBe(true);
  expect(t.list.selected()).toBe("1");
  expect(t.calls.redraws).toBeGreaterThan(0);
});

test("Down does nothing while you are typing, with no agents to select, or when a dialog has the keyboard", async () => {
  const typing = await setup([job("1", "running")], [], "half a message");
  expect(typing.press(DOWN)).toBeUndefined();
  expect(typing.list.active()).toBe(false);
  const none = await setup([job("1", "queued"), job("2", "completed", { delivered: true })]);
  expect(none.press(DOWN)).toBeUndefined();
  const dialog = await setup([job("1", "running")]);
  dialog.setFocused(false);
  expect(dialog.press(DOWN)).toBeUndefined();
});

test("Up and Down move the cursor within the rows; Up past the top closes the list", async () => {
  const t = await setup([job("1", "running"), job("2", "running"), job("3", "running")]);
  t.press(DOWN);
  t.press(DOWN);
  expect(t.list.selected()).toBe("2");
  t.press(DOWN);
  t.press(DOWN);
  expect(t.list.selected()).toBe("3"); // stops at the last row
  t.press(UP);
  expect(t.list.selected()).toBe("2");
  t.press(UP);
  t.press(UP);
  expect(t.list.active()).toBe(false);
  expect(t.list.selected()).toBeUndefined();
});

test("Escape closes the list and is consumed, so it can never cancel Pi's turn; outside the list it passes through", async () => {
  const t = await setup([job("1", "running")]);
  expect(t.press(ESC)).toBeUndefined(); // not active: Pi keeps its own Esc
  t.press(DOWN);
  expect(t.press(ESC)).toEqual({ consume: true });
  expect(t.list.active()).toBe(false);
});

test("any other key closes the list and goes on to the editor", async () => {
  const t = await setup([job("1", "running")]);
  t.press(DOWN);
  expect(t.press("a")).toBeUndefined();
  expect(t.list.active()).toBe(false);
});

test("Enter on a running agent offers steer, cancel and model; Steer sends the trimmed message", async () => {
  const t = await setup([job("1", "running")], ["Steer", "  look at auth  "]);
  t.press(DOWN);
  expect(t.press(ENTER)).toEqual({ consume: true });
  await flush();
  expect(t.asked[0]!.options).toEqual(["Steer", "Cancel", "Model and thinking", "Back"]);
  expect(t.calls.steer).toEqual([["1", "look at auth"]]);
});

test("an empty steer message sends nothing", async () => {
  const t = await setup([job("1", "running")], ["Steer", "   "]);
  t.press(DOWN);
  t.press(ENTER);
  await flush();
  expect(t.calls.steer).toEqual([]);
});

test("Cancel cancels that agent, and Model and thinking configures that agent's file", async () => {
  const c = await setup([job("1", "running")], ["Cancel"]);
  c.press(DOWN);
  c.press(ENTER);
  await flush();
  expect(c.calls.cancel).toEqual(["1"]);
  const m = await setup([job("2", "running")], ["Model and thinking"]);
  m.press(DOWN);
  m.press(ENTER);
  await flush();
  expect(m.calls.configure).toEqual(["agent-2"]);
});

test("a finished unread agent offers its result instead of steer and cancel", async () => {
  const done = job("1", "completed", { result: { status: "completed", text: "the answer", truncated: false } });
  const t = await setup([done], ["Show result"]);
  t.press(DOWN);
  t.press(ENTER);
  await flush();
  expect(t.asked[0]!.options).toEqual(["Show result", "Model and thinking", "Back"]);
  expect(t.calls.editor).toEqual([["agent-1 (completed)", "the answer"]]);
});

test("a failed agent's result includes why", async () => {
  const failed = job("1", "failed", {
    result: { status: "failed", text: "partial", truncated: false, failure: { kind: "exit", message: "Pi exited" } },
  });
  const t = await setup([failed], ["Show result"]);
  t.press(DOWN);
  t.press(ENTER);
  await flush();
  expect(t.calls.editor[0]![1]).toBe("partial\n\nPi exited");
});

test("choosing Back, or escaping the menu, does nothing; keys belong to the menu while it is open", async () => {
  const t = await setup([job("1", "running")], ["Back"]);
  t.press(DOWN);
  t.press(ENTER);
  expect(t.press(DOWN)).toBeUndefined(); // the menu is open: the list stays out of its keys
  await flush();
  expect(t.calls.steer).toEqual([]);
  expect(t.calls.cancel).toEqual([]);
  const esc = await setup([job("1", "running")], [undefined]);
  esc.press(DOWN);
  esc.press(ENTER);
  await flush();
  expect(esc.calls.cancel).toEqual([]);
});

test("an action that throws is reported, not lost", async () => {
  const t = await setup([job("1", "running")], ["Cancel"]);
  const bad = createAgentList({
    records: () => t.jobs,
    redraw() {},
    editorFocused: () => true,
    steer: async () => {},
    cancel: async () => {
      throw new Error("could not cancel");
    },
    configure: async () => {},
  });
  const notes: string[] = [];
  let h: ((d: string) => { consume?: boolean } | undefined) | undefined;
  await bad.bind({
    onTerminalInput: (x: typeof h) => ((h = x), () => {}),
    getEditorText: () => "",
    select: async () => "Cancel",
    notify: (m: string) => void notes.push(m),
  } as unknown as ExtensionUIContext);
  h!(DOWN);
  h!(ENTER);
  await flush();
  expect(notes).toEqual(["could not cancel"]);
});

test("the list closes by itself when the agents it pointed at are gone", async () => {
  const t = await setup([job("1", "running")], ["Back"]);
  t.press(DOWN);
  t.jobs.length = 0;
  t.press(ENTER);
  await flush();
  expect(t.list.active()).toBe(false);
});

test("rebinding to another terminal drops the old listener, and dispose stops listening", async () => {
  const t = await setup([job("1", "running")]);
  t.press(DOWN);
  await t.list.bind(undefined);
  expect(t.list.active()).toBe(false);
  expect(t.press(DOWN)).toBeUndefined();
});

test("Left opens a grouped manager including delivered history, and Enter opens the selected actions", async () => {
  const t = await setup(
    [
      job("done", "completed", { delivered: true }),
      job("failed", "failed"),
      job("queued", "queued"),
      job("running", "running"),
      job("interrupted", "interrupted"),
    ],
    ["Show result"],
  );
  expect(t.press(LEFT)).toEqual({ consume: true });
  await flush();
  const lines = t.manager()!.render(120).join("\n");
  expect(lines.indexOf("Working")).toBeLessThan(lines.indexOf("Queued"));
  expect(lines.indexOf("Queued")).toBeLessThan(lines.indexOf("Needs attention"));
  expect(lines.indexOf("Needs attention")).toBeLessThan(lines.indexOf("Completed"));
  expect(lines).toContain("agent-done (completed)");
  t.manager()!.handleInput(DOWN);
  t.manager()!.handleInput(DOWN);
  t.manager()!.handleInput(ENTER);
  await flush();
  expect(t.managerClosed()).toBe(1);
  expect(t.asked[0]!.title).toContain("agent-failed");
});

test("manager reads live records and Escape returns without actions", async () => {
  const t = await setup([]);
  t.press(LEFT);
  await flush();
  expect(t.manager()!.render(120).join("\n")).toContain("No agents");
  t.jobs.push(job("new", "running"));
  expect(t.manager()!.render(120).join("\n")).toContain("agent-new");
  t.manager()!.handleInput(ESC);
  await flush();
  expect(t.manager()).toBeUndefined();
  expect(t.asked).toEqual([]);
});

test("Left respects editor ownership, and disposing closes the manager", async () => {
  const t = await setup([job("1", "running")], [], "typing");
  expect(t.press(LEFT)).toBeUndefined();
  t.setText("");
  t.setFocused(false);
  expect(t.press(LEFT)).toBeUndefined();
  t.setFocused(true);
  t.press(LEFT);
  await flush();
  t.list.dispose();
  await flush();
  expect(t.managerClosed()).toBe(1);
});

test("manager scrolls long history while retaining section and key hints", async () => {
  const t = await setup(Array.from({ length: 40 }, (_, i) => job(String(i), "completed", { delivered: true })));
  t.press(LEFT);
  await flush();
  for (let i = 0; i < 39; i++) t.manager()!.handleInput(DOWN);
  const lines = t.manager()!.render(100);
  expect(lines.length).toBeLessThanOrEqual(24);
  expect(lines.join("\n")).toContain("> agent-39");
  expect(lines).toContain("Completed");
  expect(lines.at(-1)).toContain("esc close");
  t.manager()!.handleInput(ESC);
  await flush();
});

test("manager aligns unicode rows and displays live activity and result summaries", async () => {
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  const t = await setup([
    job("live", "running", { agent: "探索", progress: { turns: 1, tools: 1, tokens: 1200, active: ["read"], text: "" } }),
    job("done", "completed", { result: { status: "completed", text: "Found the answer", truncated: false }, endedAt: 2000 }),
  ]);
  t.press(LEFT);
  await flush();
  const lines = t.manager()!.render(100);
  expect(lines.join("\n")).toContain("reading");
  expect(lines.join("\n")).toContain("Found the answer");
  expect(lines.find((line) => line.includes("探索"))).toEndWith("1.2k tokens");
  for (const line of lines.filter((line) => line.includes("tokens"))) expect(visibleWidth(line)).toBe(100);
  for (const line of t
    .manager()!
    .render(12)
    .filter((line) => line.includes("tokens")))
    expect(visibleWidth(line)).toBeLessThanOrEqual(12);
  t.manager()!.handleInput(ESC);
  await flush();
});

test("queued manager entries offer cancellation rather than a result", async () => {
  const t = await setup([job("queued", "queued")], ["Cancel"]);
  t.press(LEFT);
  await flush();
  t.manager()!.handleInput(ENTER);
  await flush();
  expect(t.asked[0]!.options).toEqual(["Cancel", "Model and thinking", "Back"]);
  expect(t.calls.cancel).toEqual(["queued"]);
});
