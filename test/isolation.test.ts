import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConflictError, IsolationError, apply, create, discard, inspect } from "../src/isolation";

let tmp: string;
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out;
}
async function put(root: string, rel: string, data: string | Uint8Array) {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), data);
}
const read = (root: string, rel: string) => readFile(join(root, rel), "utf8");
const exists = (p: string) => lstat(p).then(() => true, () => false);
const mode = async (p: string) => (await lstat(p)).mode & 0o777;
const win = process.platform === "win32"; // no exec bits or reliable symlinks/chmod there
const BIN = new Uint8Array([0, 1, 2, 255, 254, 0, 7, 128]);

async function initRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "core.autocrlf", "false"); // Windows runners default to true, which turns "a\n" into "a\r\n"
  await put(dir, "a.txt", "a\n");
  await put(dir, "b.txt", "b\n");
  await put(dir, "run.sh", "#!/bin/sh\n");
  await put(dir, "bin.dat", BIN);
  await put(dir, ".gitignore", "ignored.txt\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "init");
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iso-test-"));
  repo = join(tmp, "repo");
  await initRepo(repo);
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

test("clean repo round trip: create, inspect, apply, discard", async () => {
  const ws = await create({ repoRoot: repo, id: "j1" });
  expect(ws.branch).toBe("pi-subagent/j1");
  expect(ws.path).toContain(".git");
  expect((await inspect(ws)).clean).toBe(true);
  await put(ws.path, "a.txt", "a2\n");
  await put(ws.path, "new/n.txt", "n\n");
  const r = await inspect(ws);
  expect(r.clean).toBe(false);
  expect(r.changed.sort()).toEqual(["a.txt", "new/n.txt"]);
  expect(r.diff).toContain("+a2");
  expect((await apply(ws)).applied.sort()).toEqual(["a.txt", "new/n.txt"]);
  expect(await read(repo, "a.txt")).toBe("a2\n");
  expect(await read(repo, "new/n.txt")).toBe("n\n");
  expect(await git(repo, "status", "--porcelain")).not.toContain("pi-subagents");
  await discard(ws, { force: true });
  expect(await exists(ws.path)).toBe(false);
  expect(await git(repo, "branch", "--list", ws.branch)).toBe("");
});

test("dirty tracked, staged and untracked files are carried and not seen as agent changes", async () => {
  await put(repo, "a.txt", "dirty\n");
  await put(repo, "b.txt", "staged\n");
  await git(repo, "add", "b.txt");
  await put(repo, "u/untracked.txt", "u\n");
  const ws = await create({ repoRoot: repo, id: "j" });
  expect(await read(ws.path, "a.txt")).toBe("dirty\n");
  expect(await read(ws.path, "b.txt")).toBe("staged\n");
  expect(await read(ws.path, "u/untracked.txt")).toBe("u\n");
  expect((await inspect(ws)).clean).toBe(true);
});

test("ignored files are not carried", async () => {
  await put(repo, "ignored.txt", "secret\n");
  const ws = await create({ repoRoot: repo, id: "j" });
  expect(await exists(join(ws.path, "ignored.txt"))).toBe(false);
});

test("binary, symlink and mode changes are carried", async () => {
  const changed = new Uint8Array([9, 0, 9, 0, 255]);
  await put(repo, "bin.dat", changed);
  if (!win) {
    await chmod(join(repo, "run.sh"), 0o755);
    await put(repo, "exec-new.sh", "x\n");
    await chmod(join(repo, "exec-new.sh"), 0o755);
    await symlink("a.txt", join(repo, "link"));
  }
  const ws = await create({ repoRoot: repo, id: "j" });
  expect(new Uint8Array(await readFile(join(ws.path, "bin.dat")))).toEqual(changed);
  if (!win) {
    expect(await mode(join(ws.path, "run.sh")) & 0o111).not.toBe(0);
    expect(await mode(join(ws.path, "exec-new.sh")) & 0o111).not.toBe(0);
    expect(await readlink(join(ws.path, "link"))).toBe("a.txt");
  }
  expect((await inspect(ws)).clean).toBe(true);
});

test("deleted and renamed files are carried", async () => {
  await git(repo, "rm", "-q", "b.txt");
  await git(repo, "mv", "a.txt", "a2.txt");
  const ws = await create({ repoRoot: repo, id: "j" });
  expect(await exists(join(ws.path, "b.txt"))).toBe(false);
  expect(await exists(join(ws.path, "a.txt"))).toBe(false);
  expect(await read(ws.path, "a2.txt")).toBe("a\n");
  expect((await inspect(ws)).clean).toBe(true);
});

test("agent binary edit, mode change, delete and rename apply to the parent", async () => {
  const ws = await create({ repoRoot: repo, id: "j" });
  const changed = new Uint8Array([5, 4, 0, 3]);
  await put(ws.path, "bin.dat", changed);
  if (!win) await chmod(join(ws.path, "run.sh"), 0o755);
  await rm(join(ws.path, "b.txt"));
  await rm(join(ws.path, "a.txt"));
  await put(ws.path, "renamed.txt", "a\n");
  await apply(ws);
  expect(new Uint8Array(await readFile(join(repo, "bin.dat")))).toEqual(changed);
  if (!win) expect(await mode(join(repo, "run.sh")) & 0o111).not.toBe(0);
  expect(await exists(join(repo, "b.txt"))).toBe(false);
  expect(await exists(join(repo, "a.txt"))).toBe(false);
  expect(await read(repo, "renamed.txt")).toBe("a\n");
});

test("agent commits are included in inspect and apply", async () => {
  await put(repo, "a.txt", "carried\n");
  const ws = await create({ repoRoot: repo, id: "j" });
  await put(ws.path, "a.txt", "carried\nagent\n");
  await git(ws.path, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-qam", "agent");
  expect((await inspect(ws)).changed).toEqual(["a.txt"]);
  await apply(ws);
  expect(await read(repo, "a.txt")).toBe("carried\nagent\n");
});

test("apply with diverged parent throws ConflictError and changes nothing", async () => {
  const ws = await create({ repoRoot: repo, id: "j" });
  await put(ws.path, "a.txt", "agent\n");
  await put(ws.path, "b.txt", "agent-b\n");
  await put(repo, "a.txt", "parent\n");
  await put(repo, "other.txt", "unrelated\n"); // untouched by the patch, must not block
  const err = await apply(ws).catch((e) => e);
  expect(err).toBeInstanceOf(ConflictError);
  expect(err.kind).toBe("conflict");
  expect(err.paths).toEqual(["a.txt"]);
  expect(await read(repo, "a.txt")).toBe("parent\n");
  expect(await read(repo, "b.txt")).toBe("b\n");
  expect(await exists(ws.path)).toBe(true);
  expect(await read(ws.path, "a.txt")).toBe("agent\n");
});

test("apply on a non-conflicting parent change succeeds", async () => {
  const ws = await create({ repoRoot: repo, id: "j" });
  await put(ws.path, "a.txt", "agent\n");
  await put(repo, "b.txt", "parent-b\n");
  await apply(ws);
  expect(await read(repo, "a.txt")).toBe("agent\n");
  expect(await read(repo, "b.txt")).toBe("parent-b\n");
});

// Windows git replaces the blocking file with a directory instead of failing, so this trigger is POSIX-only.
test.skipIf(win)("apply failure leaves worktree and parent intact", async () => {
  const ws = await create({ repoRoot: repo, id: "j" });
  await put(ws.path, "dir/x.txt", "x\n");
  await put(repo, "dir", "i am a file\n"); // git apply cannot create dir/x.txt
  const err = await apply(ws).catch((e) => e);
  expect(err).toBeInstanceOf(IsolationError);
  expect(err.kind).toBe("git");
  expect(err.message).toContain("kept");
  expect(await read(repo, "dir")).toBe("i am a file\n");
  expect(await read(ws.path, "dir/x.txt")).toBe("x\n");
  expect(await git(repo, "branch", "--list", ws.branch)).toContain(ws.branch);
});

test("apply to a missing repo throws missing", async () => {
  const ws = await create({ repoRoot: repo, id: "j" });
  await put(ws.path, "a.txt", "agent\n");
  const gone = { ...ws, repoRoot: join(tmp, "nope") };
  expect((await apply(gone).catch((e) => e)).kind).toBe("missing");
});

test("discard with changes requires force; unmodified is removed with its branch", async () => {
  const ws = await create({ repoRoot: repo, id: "j" });
  await put(ws.path, "new.txt", "n\n");
  const err = await discard(ws).catch((e) => e);
  expect(err.kind).toBe("dirty");
  expect(await exists(ws.path)).toBe(true);
  await rm(join(ws.path, "new.txt"));
  await discard(ws);
  expect(await exists(ws.path)).toBe(false);
  expect(await git(repo, "branch", "--list", ws.branch)).toBe("");
  expect(await git(repo, "for-each-ref", "refs/pi-subagents")).toBe("");
  const ws2 = await create({ repoRoot: repo, id: "k" });
  await put(ws2.path, "new.txt", "n\n");
  await discard(ws2, { force: true });
  expect(await exists(ws2.path)).toBe(false);
});

test("inspect truncates large diffs with a marker", async () => {
  const ws = await create({ repoRoot: repo, id: "j" });
  await put(ws.path, "big.txt", "line of text\n".repeat(20_000));
  const r = await inspect(ws);
  expect(r.diff).toContain("[diff truncated:");
  expect(r.diff.length).toBeLessThan(110_000);
});

test("four concurrent creates from one repo", async () => {
  const wss = await Promise.all([1, 2, 3, 4].map((i) => create({ repoRoot: repo, id: `c${i}` })));
  expect(new Set(wss.map((w) => w.path)).size).toBe(4);
  for (const w of wss) expect(await read(w.path, "a.txt")).toBe("a\n");
  await Promise.all(wss.map((w) => discard(w)));
});

test("custom baseDir is honoured", async () => {
  const ws = await create({ repoRoot: repo, id: "j", baseDir: join(tmp, "wts") });
  expect(ws.path).toBe(join(tmp, "wts", "j"));
  expect(await exists(join(ws.path, "a.txt"))).toBe(true);
});

// chmod 000 does not make a file unreadable on Windows, so the failure cannot be provoked there.
test.skipIf(win)("carry failure keeps a modified worktree and reports its path", async () => {
  await put(repo, "u1.txt", "1\n");
  await put(repo, "u2.txt", "2\n");
  await chmod(join(repo, "u2.txt"), 0o000);
  const asRoot = process.getuid?.() === 0;
  const err = await create({ repoRoot: repo, id: "j" }).catch((e) => e);
  await chmod(join(repo, "u2.txt"), 0o644);
  if (asRoot) return; // root can read anything, nothing fails
  expect(err).toBeInstanceOf(IsolationError);
  expect(err.kind).toBe("carry");
  expect(err.path).toBeTruthy();
  expect(err.message).toContain("kept");
  expect(await exists(err.path)).toBe(true);
});

test("repo with no commits gives a clear error", async () => {
  const empty = join(tmp, "empty");
  await mkdir(empty);
  await git(empty, "init", "-q");
  const err = await create({ repoRoot: empty, id: "j" }).catch((e) => e);
  expect(err).toBeInstanceOf(IsolationError);
  expect(err.message).toContain("no commits");
});

test("not a git repo gives a clear error", async () => {
  const plain = join(tmp, "plain");
  await mkdir(plain);
  const err = await create({ repoRoot: plain, id: "j" }).catch((e) => e);
  expect(err).toBeInstanceOf(IsolationError);
  expect(err.message).toContain("not a git repository");
});

test("invalid ids are rejected", async () => {
  for (const id of ["", "../x", "-x", "a b"]) {
    expect((await create({ repoRoot: repo, id }).catch((e) => e)).message).toContain("invalid");
  }
});

// Tabs are valid POSIX filenames, but forbidden in Windows filenames.
test.skipIf(win)("apply preserves tabs in tracked filenames", async () => {
  const name = "a\tb.txt";
  await put(repo, name, "original\n");
  await git(repo, "add", name);
  await git(repo, "commit", "-qm", "tab filename");
  const ws = await create({ repoRoot: repo, id: "tab" });
  await put(ws.path, name, "agent\n");
  expect((await inspect(ws)).changed).toEqual([name]);
  expect((await apply(ws)).applied).toEqual([name]);
  expect(await read(repo, name)).toBe("agent\n");
});

test("inspect counts omitted Unicode characters without retaining the full diff", async () => {
  const ws = await create({ repoRoot: repo, id: "unicode" });
  await put(ws.path, "unicode.txt", "😀é\n".repeat(100_000));
  const result = await inspect(ws);
  const full = await git(ws.path, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--src-prefix=a/", "--dst-prefix=b/", `refs/pi-subagents/${ws.id}/snapshot`);
  const marker = /\n\[diff truncated: (\d+) characters omitted\]\n$/;
  const prefix = result.diff.replace(marker, "");
  expect(prefix.length).toBeLessThanOrEqual(100_000);
  expect(full.startsWith(prefix)).toBe(true);
  expect(Number((marker.exec(result.diff))?.[1])).toBe(full.length - prefix.length);
  expect(prefix).not.toContain("�");
  // Inspection truncation must not truncate the patch subsequently applied.
  await apply(ws);
  expect(await read(repo, "unicode.txt")).toBe(await read(ws.path, "unicode.txt"));
});

// A clean filter can edit the worktree while apply checks the parent. Its patch
// must still match the already inspected path set, not a second staging scan.
test.skipIf(win)("apply uses one frozen tree even if files change during conflict checks", async () => {
  await put(repo, ".gitattributes", "a.txt filter=mutate\n");
  await git(repo, "add", ".gitattributes");
  await git(repo, "commit", "-qm", "attributes");
  const ws = await create({ repoRoot: repo, id: "frozen" });
  await put(ws.path, "a.txt", "agent\n");
  const script = join(tmp, "mutate.cjs");
  await writeFile(script, `
    const fs = require("node:fs");
    if (fs.realpathSync(process.cwd()) === fs.realpathSync(${JSON.stringify(repo)}))
      fs.writeFileSync(${JSON.stringify(join(ws.path, "b.txt"))}, "late edit\\n");
    process.stdout.write(fs.readFileSync(0));
  `);
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  await git(repo, "config", "filter.mutate.clean", `${quote(process.execPath)} ${quote(script)}`);
  expect((await apply(ws)).applied).toEqual(["a.txt"]);
  expect(await read(ws.path, "b.txt")).toBe("late edit\n");
  expect(await read(repo, "b.txt")).toBe("b\n");
  expect(await read(repo, "a.txt")).toBe("agent\n");
});

test("failed worktree add does not block the next creation", async () => {
  await git(repo, "branch", "pi-subagent/blocked");
  const [failed, next] = await Promise.allSettled([
    create({ repoRoot: repo, id: "blocked" }),
    create({ repoRoot: repo, id: "next" }),
  ]);
  expect(failed.status).toBe("rejected");
  expect(next.status).toBe("fulfilled");
  if (next.status === "fulfilled") expect((await inspect(next.value)).clean).toBe(true);
});
