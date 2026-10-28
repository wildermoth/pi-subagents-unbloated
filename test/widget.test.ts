import { afterEach, expect, test } from "bun:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { JobRecord } from "../src/jobs.ts";
import { createWidget } from "../src/widget.ts";

const rec = (state: JobRecord["state"], o: Partial<JobRecord> = {}): JobRecord => ({
  id: "j1",
  agent: "scout",
  task: "look",
  state,
  createdAt: 0,
  delivered: false,
  ...o,
});

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

/** A UI stand-in that, like Pi, builds the widget component as soon as it is mounted. */
function fakeUi() {
  const log = { mounts: 0, clears: 0, renders: 0 };
  let mounted: { render(w: number): string[] } | undefined;
  const tui = { requestRender: () => void log.renders++ };
  const ui = {
    setWidget(_key: string, content: unknown) {
      if (content === undefined) log.clears++;
      else {
        log.mounts++;
        mounted = (content as (t: unknown, th: unknown) => { render(w: number): string[] })(tui, theme);
      }
    },
  } as unknown as ExtensionUIContext;
  return { ui, log, component: () => mounted! };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let live: ReturnType<typeof createWidget> | undefined;
afterEach(() => live?.dispose());

test("mounts once, repaints on update, and clears when nothing is left", () => {
  let jobs = [rec("running", { activity: "hello" })];
  const f = fakeUi();
  live = createWidget(() => jobs);
  live.bind(f.ui);
  live.update();
  expect(f.log.mounts).toBe(1);
  expect(f.component().render(80)[1]).toContain("scout");
  const before = f.log.renders;
  live.update();
  expect(f.log.mounts).toBe(1); // not remounted
  expect(f.log.renders).toBeGreaterThan(before);
  jobs = [rec("completed", { delivered: true, endedAt: 5 })];
  live.update();
  expect(f.log.clears).toBe(1);
});

test("animates only while a job is running, and stops on its own", async () => {
  let jobs = [rec("running")];
  const f = fakeUi();
  live = createWidget(() => jobs);
  live.bind(f.ui);
  await sleep(350);
  expect(f.log.renders).toBeGreaterThanOrEqual(3);
  jobs = [rec("queued")]; // still shown, but nothing to animate
  live.update();
  const settled = f.log.renders;
  await sleep(250);
  expect(f.log.renders).toBeLessThanOrEqual(settled + 1);
});

test("a new UI context remounts, and dispose clears and stops the timer", async () => {
  const f1 = fakeUi();
  const f2 = fakeUi();
  live = createWidget(() => [rec("running")]);
  live.bind(f1.ui);
  live.bind(f2.ui);
  expect(f2.log.mounts).toBe(1);
  live.dispose();
  expect(f2.log.clears).toBe(1);
  const after = f2.log.renders;
  await sleep(250);
  expect(f2.log.renders).toBe(after);
});

test("a stale UI context is swallowed, then recovered by the next bind", () => {
  const stale = {
    setWidget() {
      throw new Error("stale context");
    },
  } as unknown as ExtensionUIContext;
  const f = fakeUi();
  live = createWidget(() => [rec("running")]);
  expect(() => live!.bind(stale)).not.toThrow();
  live.bind(f.ui);
  expect(f.log.mounts).toBe(1);
});

test("without a UI, updates do nothing", () => {
  live = createWidget(() => [rec("running")]);
  expect(() => {
    live!.update();
    live!.bind(undefined);
    live!.update();
  }).not.toThrow();
});
