import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgs, createRunner, resolvePiCommand } from "../src/runner.ts";
import type { Child, RunSpec } from "../src/types.ts";

const spec = (o: Partial<RunSpec> = {}): RunSpec => ({
  cwd: process.cwd(), task: "do it", systemPrompt: "you are a test", trusted: false,
  timeoutMs: 5000, launchTimeoutMs: 3000, ...o,
});

const dir = mkdtempSync(join(tmpdir(), "fakepi-"));
let n = 0;
const started: Child[] = [];
function run(mode: string, s: Partial<RunSpec> = {}, ro: { maxResultBytes?: number; graceMs?: number } = {}, extra: string[] = []) {
  const pidFile = join(dir, `pid${n++}`);
  const runner = createRunner({
    graceMs: 150,
    ...ro,
    piCommand: () => ({ command: process.execPath, args: [join(import.meta.dir, "fake-pi.ts"), `--fake=${mode}`, `--fake-pid-file=${pidFile}`, ...extra] }),
  });
  const child = runner.start(spec(s));
  started.push(child);
  const pid = () => Number(readFileSync(pidFile, "utf8"));
  return { child, pid };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

afterEach(async () => {
  await Promise.all(started.splice(0).map((c) => c.cancel()));
});

describe("results", () => {
  test("normal answer", async () => {
    const r = await run("normal").child.done;
    expect(r).toEqual({ status: "completed", text: "hello", truncated: false });
  });
  test("delayed answer", async () => {
    expect((await run("delayed", {}, {}, ["--delay=100"]).child.done).text).toBe("delayed answer");
  });
  test("unicode separators and split chunks survive", async () => {
    expect((await run("unicode").child.done).text).toBe("line1 line2 line3 \u{1F600}");
    expect((await run("split").child.done).text).toBe("split \u{1F600} answer   ok");
  });
  test("truncation with marker, bounded in bytes, UTF-8 safe", async () => {
    const r = await run("huge", {}, { maxResultBytes: 1000 }).child.done;
    expect(r.status).toBe("completed");
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(1000);
    expect(r.text).toContain("[truncated:");
    const u = await run("huge-unicode", {}, { maxResultBytes: 1001 }).child.done;
    expect(Buffer.byteLength(u.text)).toBeLessThanOrEqual(1001);
    expect(u.text).not.toContain("�");
  });
  test("default limit 8192", async () => {
    const r = await run("huge").child.done;
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(8192);
    expect(r.truncated).toBe(true);
  });
  test("extension dialogs are cancelled, notifications ignored", async () => {
    expect((await run("ui").child.done).text).toBe("ui:cancelled");
  });
  test("stderr flood does not disturb the run", async () => {
    expect((await run("stderr-flood").child.done).text).toBe("flooded");
  });
});

describe("flags", () => {
  test("args, env and cwd", async () => {
    const r = await run("echo-args", { tools: ["read", "grep"], model: "m/x", thinking: "high", trusted: true, systemPrompt: "SP", cwd: dir }).child.done;
    const got = JSON.parse(r.text);
    const a: string[] = got.args;
    const after = a.slice(a.indexOf("--mode"));
    expect(after).toEqual(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
      "--no-mcp", "--offline", "--no-session", "--tools", "read,grep", "--model", "m/x", "--thinking", "high",
      "--append-system-prompt", "SP", "--approve"]);
    expect(a).not.toContain("--no-context-files");
    expect(got.env).toBe("1");
    expect(got.cwd).toBe(require("node:fs").realpathSync(dir));
  });
  test("buildArgs variants", () => {
    const a = buildArgs(spec({ tools: [] }));
    expect(a).toContain("--no-tools");
    expect(a).toContain("--no-approve");
    const b = buildArgs(spec());
    expect(b).not.toContain("--tools");
    expect(b).not.toContain("--no-tools");
  });
  test("resolvePiCommand order", () => {
    expect(resolvePiCommand({ PI_BIN: "/x/pi" }, "/a/cli.js")).toEqual({ command: "/x/pi", args: [] });
    expect(resolvePiCommand({}, "/opt/pi-coding-agent/dist/cli.js")).toEqual({ command: process.execPath, args: ["/opt/pi-coding-agent/dist/cli.js"] });
    expect(resolvePiCommand({}, "/repo/foo.test.ts")).toEqual({ command: "pi", args: [] });
  });
});

describe("failures", () => {
  test("launch failure", async () => {
    const r = await createRunner({ piCommand: () => ({ command: "/nonexistent/pi", args: [] }) }).start(spec()).done;
    expect(r.failure?.kind).toBe("launch");
  });
  test("launch failure when resolution throws", async () => {
    const r = await createRunner({ piCommand: () => { throw new Error("no pi"); } }).start(spec()).done;
    expect(r.failure?.kind).toBe("launch");
  });
  test("exit before ack", async () => {
    const r = await run("exit-before-ack").child.done;
    expect(r.status).toBe("failed");
    expect(r.failure?.kind).toBe("exit");
    expect(r.failure?.message).toContain("boom");
  });
  test("accepted then exit", async () => {
    const r = await run("exit-after-ack").child.done;
    expect(r.failure?.kind).toBe("exit");
    expect(r.failure?.message).toContain("crash after ack");
  });
  test("launch ack timeout", async () => {
    const t = Date.now();
    const r = await run("never-acks", { launchTimeoutMs: 200 }).child.done;
    expect(r.failure?.kind).toBe("timeout");
    expect(Date.now() - t).toBeLessThan(3000);
  });
  test("missing agent_settled times out", async () => {
    const { child, pid } = run("never-settles", { timeoutMs: 300 });
    const r = await child.done;
    expect(r.failure?.kind).toBe("timeout");
    expect(alive(pid())).toBe(false);
  });
  test("rejected and handled prompts", async () => {
    expect((await run("rejected").child.done).failure?.kind).toBe("rejected");
    expect((await run("handled").child.done).failure?.kind).toBe("rejected");
  });
  test("malformed output is a protocol failure and child is killed", async () => {
    const { child, pid } = run("malformed");
    expect((await child.done).failure?.kind).toBe("protocol");
    expect(alive(pid())).toBe(false);
  });
  test("record overflow is a protocol failure", async () => {
    const { child, pid } = run("overflow");
    expect((await child.done).failure?.kind).toBe("protocol");
    expect(alive(pid())).toBe(false);
  });
  test("provider error", async () => {
    const r = await run("provider-error").child.done;
    expect(r.failure).toEqual({ kind: "provider", message: "529 overloaded" });
    expect(r.text).toBe("");
  });
  test("settled without assistant message is not a silent success", async () => {
    expect((await run("settle-no-message").child.done).failure?.kind).toBe("protocol");
  });
  test("unexpected abort is a failure", async () => {
    expect((await run("aborted-run").child.done).failure?.kind).toBe("provider");
  });
});

describe("cancel and steer", () => {
  test("cancel while running", async () => {
    const { child, pid } = run("never-settles");
    await Bun.sleep(300);
    await child.cancel();
    expect((await child.done).status).toBe("cancelled");
    expect(alive(pid())).toBe(false);
  });
  test("cancel is idempotent, also concurrently", async () => {
    const { child } = run("never-settles");
    await Bun.sleep(200);
    await Promise.all([child.cancel(), child.cancel()]);
    await child.cancel();
    expect((await child.done).status).toBe("cancelled");
  });
  test("cancel after completion keeps completed", async () => {
    const { child } = run("normal");
    const r = await child.done;
    await child.cancel();
    await child.cancel();
    expect(await child.done).toBe(r);
    expect(r.status).toBe("completed");
  });
  test("cancel racing completion is deterministic", async () => {
    const { child } = run("delayed", {}, {}, ["--delay=120"]);
    await Bun.sleep(110);
    await child.cancel();
    const r = await child.done;
    expect(["completed", "cancelled"]).toContain(r.status);
    await child.cancel();
    expect(await child.done).toBe(r);
  });
  test("cancel before spawn settles", async () => {
    const { child } = run("never-acks");
    await child.cancel();
    expect((await child.done).status).toBe("cancelled");
  });
  test("child ignoring stdin close and SIGTERM is force-killed", async () => {
    const { child, pid } = run("stubborn");
    await Bun.sleep(400);
    const p = pid();
    expect(alive(p)).toBe(true);
    const t = Date.now();
    await child.cancel();
    expect((await child.done).status).toBe("cancelled");
    expect(alive(p)).toBe(false);
    expect(Date.now() - t).toBeLessThan(2000);
  });
  test("timeout also force-kills a stubborn child", async () => {
    const { child, pid } = run("stubborn", { timeoutMs: 300 });
    expect((await child.done).failure?.kind).toBe("timeout");
    expect(alive(pid())).toBe(false);
  });
  test("steer delivers the message", async () => {
    const { child } = run("steerable");
    await Bun.sleep(300);
    await child.steer("go left");
    expect((await child.done).text).toBe("steered:go left");
  });
  test("steer after finish is rejected", async () => {
    const { child } = run("normal");
    await child.done;
    await expect(child.steer("late")).rejects.toThrow();
  });
});
