import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness, ok, run, started, tick, txt } from "./helpers/harness.ts";

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function sh(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}

/** A committed repo with a writer agent, plus a file the agents will edit. */
async function repo() {
  const cwd = await mkdtemp(join(tmpdir(), "psu-iso-"));
  dirs.push(cwd);
  await sh(cwd, "init", "-q");
  await sh(cwd, "config", "user.email", "t@t");
  await sh(cwd, "config", "user.name", "t");
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(join(cwd, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: Edit\ntools: read,bash,edit,write\n---\nWork.");
  await writeFile(join(cwd, "a.txt"), "one\n");
  await sh(cwd, "add", "-A");
  await sh(cwd, "commit", "-qm", "init");
  return cwd;
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const start = async (h: ReturnType<typeof harness>, cwd: string, extra: object = {}) =>
  txt(await run(h, cwd, { action: "start", agent: "worker", task: "edit", ...extra })).split(" ")[1]!;

test("isolated job runs in a worktree, diff shows its edits, apply lands them in the parent", async () => {
  const cwd = await repo();
  const h = harness();
  h.handlers.session_start!({}, h.ctx(cwd));
  const id = await start(h, cwd, { isolate: true });
  const wt = h.ctls[0]!.spec.cwd;
  expect(wt).not.toBe(cwd);
  expect(wt).toContain("pi-subagents");
  await writeFile(join(wt, "a.txt"), "one\ntwo\n");
  await writeFile(join(wt, "b.txt"), "new\n");
  h.setIdle(false);
  h.ctls[0]!.finish(ok("edited"));
  await tick();
  expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("one\n"); // parent untouched until apply
  const d = txt(await run(h, cwd, { action: "diff", id }));
  expect(d).toContain("a.txt");
  expect(d).toContain("b.txt");
  expect(txt(await run(h, cwd, { action: "inbox" }))).toContain(`apply or discard ${id}`); // result tells the model what to do
  expect(txt(await run(h, cwd, { action: "apply", id }))).toContain("applied");
  expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("one\ntwo\n");
  expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("new\n");
  expect(await exists(wt)).toBe(false);
  await expect(run(h, cwd, { action: "apply", id })).rejects.toThrow("no isolated worktree");
});

test("isolated writers run in parallel while shared writers serialize", async () => {
  const cwd = await repo();
  const h = harness();
  await start(h, cwd, { isolate: true });
  await start(h, cwd, { isolate: true });
  await started(h, 2);
  expect(h.ctls.length).toBe(2);
  expect(h.ctls[0]!.spec.cwd).not.toBe(h.ctls[1]!.spec.cwd);
  const h2 = harness();
  await start(h2, cwd);
  await start(h2, cwd);
  await tick();
  expect(h2.ctls.length).toBe(1); // second writer queued behind the first
  for (const c of [...h.ctls, ...h2.ctls]) c.finish(ok("x"));
});

test("apply is refused while the job is running; discard removes the worktree", async () => {
  const cwd = await repo();
  const h = harness();
  const id = await start(h, cwd, { isolate: true });
  await started(h);
  await expect(run(h, cwd, { action: "apply", id })).rejects.toThrow("wait or cancel");
  await run(h, cwd, { action: "cancel", id });
  const wt = h.ctls[0]!.spec.cwd;
  expect(txt(await run(h, cwd, { action: "discard", id }))).toContain("discarded");
  expect(await exists(wt)).toBe(false);
});

test("apply conflict changes nothing and keeps the worktree", async () => {
  const cwd = await repo();
  const h = harness();
  const id = await start(h, cwd, { isolate: true });
  await started(h);
  const wt = h.ctls[0]!.spec.cwd;
  await writeFile(join(wt, "a.txt"), "agent\n");
  h.ctls[0]!.finish(ok("done"));
  await tick();
  await writeFile(join(cwd, "a.txt"), "parent edit\n"); // parent diverged on a touched file
  await expect(run(h, cwd, { action: "apply", id })).rejects.toThrow("a.txt");
  expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("parent edit\n");
  expect(await readFile(join(wt, "a.txt"), "utf8")).toBe("agent\n");
});

test("worktrees survive a restart and can still be applied", async () => {
  const cwd = await repo();
  const h = harness();
  const id = await start(h, cwd, { isolate: true });
  await started(h);
  await writeFile(join(h.ctls[0]!.spec.cwd, "c.txt"), "kept\n");
  h.ctls[0]!.finish(ok("done"));
  await tick();
  await h.handlers.session_shutdown!({ reason: "quit" }, h.ctx(cwd));
  const branch = h.entries.map((e) => ({ type: "custom", customType: e.type, data: e.data }));
  const h2 = harness(branch);
  await h2.handlers.session_start!({}, h2.ctx(cwd));
  expect(txt(await run(h2, cwd, { action: "apply", id }))).toContain("c.txt");
  expect(await readFile(join(cwd, "c.txt"), "utf8")).toBe("kept\n");
});

test("isolate outside a git repo fails clearly without starting a job", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "psu-nogit-"));
  dirs.push(cwd);
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(join(cwd, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: Edit\n---\nWork.");
  const h = harness();
  await expect(run(h, cwd, { action: "start", agent: "worker", task: "x", isolate: true })).rejects.toThrow(/git/);
  expect(h.ctls.length).toBe(0);
});
