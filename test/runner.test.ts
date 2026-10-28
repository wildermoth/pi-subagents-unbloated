import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiCommand } from "../src/pi-command.ts";
import { buildArgs, createRunner } from "../src/runner.ts";
import type { Child, RunSpec } from "../src/types.ts";

const spec = (o: Partial<RunSpec> = {}): RunSpec => ({
  cwd: process.cwd(),
  task: "do it",
  systemPrompt: "you are a test",
  trusted: false,
  timeoutMs: 5000,
  launchTimeoutMs: 3000,
  ...o,
});

const dir = mkdtempSync(join(tmpdir(), "fakepi-"));
let n = 0;
const started: Child[] = [];
function run(mode: string, s: Partial<RunSpec> = {}, ro: { maxResultBytes?: number; graceMs?: number } = {}, extra: string[] = []) {
  const pidFile = join(dir, `pid${n++}`);
  const runner = createRunner({
    graceMs: 150,
    ...ro,
    piCommand: () => ({
      command: process.execPath,
      args: [join(import.meta.dir, "fake-pi.ts"), `--fake=${mode}`, `--fake-pid-file=${pidFile}`, ...extra],
    }),
  });
  const child = runner.start(spec(s));
  started.push(child);
  const pid = () => Number(readFileSync(pidFile, "utf8"));
  return { child, pid };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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
  test("truncation respects tiny caps and reports actual omitted bytes", async () => {
    for (const max of [0, 1, 10, 11, 45, 1001]) {
      const r = await run("huge-unicode", {}, { maxResultBytes: max }).child.done;
      expect(r.truncated).toBe(true);
      expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(max);
      expect(r.text).not.toContain("�");
      const match = /\n\[truncated: (\d+) of (\d+) bytes omitted\]$/.exec(r.text);
      if (match) {
        const kept = Buffer.byteLength(r.text.slice(0, match.index));
        expect(Number(match[1]) + kept).toBe(Number(match[2]));
      }
    }
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
    const r = await run("echo-args", {
      tools: ["read", "grep"],
      model: "m/x",
      thinking: "high",
      trusted: true,
      systemPrompt: "SP",
      cwd: dir,
    }).child.done;
    const got = JSON.parse(r.text);
    const a: string[] = got.args;
    const after = a.slice(a.indexOf("--mode"));
    expect(after).toEqual([
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--offline",
      "--no-session",
      "--tools",
      "read,grep",
      "--model",
      "m/x",
      "--thinking",
      "high",
      "--append-system-prompt",
      "SP",
      "--approve",
    ]);
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
    expect(resolvePiCommand({ PI_BIN: "/x/pi" }, "/a/cli.js", { platform: "linux" })).toEqual({ command: "/x/pi", args: [] });
    expect(resolvePiCommand({}, "/opt/pi-coding-agent/dist/cli.js", { platform: "linux" })).toEqual({
      command: process.execPath,
      args: ["/opt/pi-coding-agent/dist/cli.js"],
    });
    expect(resolvePiCommand({}, "/repo/foo.test.ts", { platform: "linux", resolvePackage: () => undefined })).toEqual({
      command: "pi",
      args: [],
    });
  });
});

describe("failures", () => {
  test("launch failure", async () => {
    const r = await createRunner({ piCommand: () => ({ command: "/nonexistent/pi", args: [] }) }).start(spec()).done;
    expect(r.failure?.kind).toBe("launch");
  });
  test("launch failure when resolution throws", async () => {
    const r = await createRunner({
      piCommand: () => {
        throw new Error("no pi");
      },
    }).start(spec()).done;
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
  test("hitting the output length limit is a provider failure that keeps the partial text", async () => {
    const r = await run("length").child.done;
    expect(r.status).toBe("failed");
    expect(r.failure?.kind).toBe("provider");
    expect(r.text).toBe("cut off mid sen");
  });
  test("timeout and cancel keep what the child had already said", async () => {
    const t = await run("partial-hang", { timeoutMs: 400 }).child.done;
    expect(t.failure?.kind).toBe("timeout");
    expect(t.text).toBe("so far so good");
    const { child } = run("partial-hang");
    await Bun.sleep(300);
    await child.cancel();
    const c = await child.done;
    expect(c.status).toBe("cancelled");
    expect(c.text).toBe("so far so good");
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
  test.skipIf(process.platform === "win32")("descendants are terminated after their leader exits on stdin EOF", async () => {
    for (const mode of ["descendant", "descendant-hang"]) {
      const descendantPid = join(dir, `descendant-${n}`);
      const descendantExit = `${descendantPid}-exit`;
      const { child } = run(mode, {}, {}, [`--descendant-pid=${descendantPid}`, `--descendant-exit=${descendantExit}`]);
      try {
        for (let i = 0; i < 1000 && !existsSync(descendantPid); i++) await Bun.sleep(2);
        expect(existsSync(descendantPid)).toBe(true);
        if (mode === "descendant-hang") await child.cancel();
        expect((await child.done).status).toBe(mode === "descendant" ? "completed" : "cancelled");
        expect(readFileSync(descendantExit, "utf8")).toBe("terminated");
      } finally {
        if (existsSync(descendantPid)) {
          try {
            process.kill(Number(readFileSync(descendantPid, "utf8")), "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    }
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

describe("resolvePiCommand cross-platform", () => {
  const fsOf = (files: Record<string, string>) => ({
    exists: (p: string) => p in files,
    read: (p: string) => files[p],
  });
  const PKG = "C:\\npm\\node_modules\\@earendil-works\\pi-coding-agent";
  const SHIM = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    ")",
    "",
    'endLocal & goTo #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
  ].join("\r\n");
  const none = () => undefined;
  const NODE = "/usr/bin/node";

  test("PI_BIN wins over everything", () => {
    expect(
      resolvePiCommand({ PI_BIN: "/x/pi" }, "/o/pi-coding-agent/cli.js", { platform: "linux", resolvePackage: none, execPath: NODE }),
    ).toEqual({ command: "/x/pi", args: [] });
  });
  test("package bin.pi is used after argv1 and before PATH", () => {
    const f = fsOf({
      "/n/node_modules/@earendil-works/pi-coding-agent/package.json": JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        bin: { pi: "dist/bundle/cli.js" },
      }),
      "/n/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js": "",
    });
    const r = resolvePiCommand({}, "/repo/x.test.ts", {
      ...f,
      platform: "linux",
      execPath: NODE,
      resolvePackage: () => "/n/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    });
    expect(r).toEqual({ command: NODE, args: ["/n/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"] });
  });
  test("package route is skipped when the host runtime is not node", () => {
    const f = fsOf({
      "/n/p/package.json": JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "cli.js" } }),
      "/n/p/cli.js": "",
    });
    expect(
      resolvePiCommand({}, "/repo/x.test.ts", { ...f, platform: "linux", execPath: "/usr/bin/bun", resolvePackage: () => "/n/p/index.js" }),
    ).toEqual({ command: "pi", args: [] });
  });
  test("package resolution failure falls through to PATH", () => {
    const boom = () => {
      throw new Error("nope");
    };
    expect(resolvePiCommand({}, "/repo/x.test.ts", { platform: "linux", resolvePackage: boom })).toEqual({ command: "pi", args: [] });
    const f = fsOf({ "/n/pkg/package.json": "{not json" });
    expect(resolvePiCommand({}, "/repo/x.test.ts", { ...f, platform: "linux", resolvePackage: () => "/n/pkg/index.js" })).toEqual({
      command: "pi",
      args: [],
    });
  });
  test("win32 PATH lookup honours PATHEXT and parses the npm shim", () => {
    const f = fsOf({
      "C:\\npm\\pi.CMD": SHIM,
      [`${PKG}\\dist\\bundle\\cli.js`]: "",
    });
    const r = resolvePiCommand({ Path: "C:\\bin;C:\\npm", PATHEXT: ".EXE;.CMD" }, "C:\\t\\x.test.ts", {
      ...f,
      platform: "win32",
      resolvePackage: none,
      execPath: NODE,
    });
    expect(r).toEqual({ command: NODE, args: [`${PKG}\\dist\\bundle\\cli.js`] });
  });
  test("win32 PATH finds a real .exe directly", () => {
    const f = fsOf({ "C:\\bin\\pi.exe": "" });
    expect(
      resolvePiCommand({ PATH: "C:\\bin", PATHEXT: ".exe" }, undefined, { ...f, platform: "win32", resolvePackage: none, execPath: NODE }),
    ).toEqual({ command: "C:\\bin\\pi.exe", args: [] });
  });
  test("win32 PI_BIN pointing at a .cmd shim is unwrapped", () => {
    const f = fsOf({ "C:\\npm\\pi.cmd": SHIM, [`${PKG}\\dist\\bundle\\cli.js`]: "" });
    expect(
      resolvePiCommand({ PI_BIN: "C:\\npm\\pi.cmd" }, undefined, { ...f, platform: "win32", resolvePackage: none, execPath: NODE }).args,
    ).toEqual([`${PKG}\\dist\\bundle\\cli.js`]);
  });
  test("win32 unparsable shim fails with a clear error", () => {
    const f = fsOf({ "C:\\npm\\pi.cmd": "@echo off\r\nsome-wrapper.exe %*\r\n" });
    expect(() =>
      resolvePiCommand({ PATH: "C:\\npm", PATHEXT: ".cmd" }, undefined, { ...f, platform: "win32", resolvePackage: none, execPath: NODE }),
    ).toThrow(/cannot launch Pi from shim/);
  });
  test("win32 missing pi fails with a clear error", () => {
    expect(() =>
      resolvePiCommand({ PATH: "C:\\bin", PATHEXT: ".exe" }, undefined, {
        ...fsOf({}),
        platform: "win32",
        resolvePackage: none,
        execPath: NODE,
      }),
    ).toThrow(/cannot find `pi` on PATH/);
  });
});
