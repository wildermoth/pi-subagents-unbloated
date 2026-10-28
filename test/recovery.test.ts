import { expect, test } from "bun:test";
import { JOB_ENTRY, recover, UNREAD_ENTRY, WS_ENTRY } from "../src/recovery.ts";
import type { JobRecord } from "../src/jobs.ts";

const rec = (id: string, state: JobRecord["state"] = "completed"): JobRecord => ({
  id,
  agent: "a",
  task: "t",
  state,
  createdAt: 0,
  delivered: false,
});
const custom = (customType: string, data: unknown) => ({ type: "custom", customType, data });

test("one pass restores jobs, live worktrees and unread results", () => {
  const ws = { path: "/w", branch: "b" } as never;
  const out = recover([
    { type: "message" },
    custom(JOB_ENTRY, rec("j1", "running")),
    custom(JOB_ENTRY, rec("j1", "completed")),
    custom(WS_ENTRY, { jobId: "j1", ws }),
    custom(WS_ENTRY, { jobId: "j2", ws }),
    custom(WS_ENTRY, { jobId: "j2", discarded: true }),
    custom(UNREAD_ENTRY, { records: [rec("j1"), rec("j3")] }),
    custom(UNREAD_ENTRY, { ack: ["j3"] }),
    custom("other", { x: 1 }),
  ]);
  expect(out.jobs.map((j) => `${j.id}:${j.state}`)).toEqual(["j1:running", "j1:completed"]);
  expect([...out.workspaces.keys()]).toEqual(["j1"]);
  expect(out.unread.map((r) => r.id)).toEqual(["j1"]);
});

test("an empty branch recovers nothing", () => {
  const out = recover([]);
  expect(out.jobs).toEqual([]);
  expect(out.workspaces.size).toBe(0);
  expect(out.unread).toEqual([]);
});
