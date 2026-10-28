// Git worktree isolation: one worktree + branch per writing job.
// All git runs async via argv arrays. Submodules are not supported (gitlinks and
// nested repos are skipped when carrying untracked files).
import { chmod, copyFile, lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

export interface Workspace {
  id: string;
  repoRoot: string;
  path: string;
  branch: string;
  baseCommit: string;
}

export type IsolationErrorKind = "carry" | "conflict" | "dirty" | "git" | "missing";

export class IsolationError extends Error {
  constructor(
    public kind: IsolationErrorKind,
    message: string,
    public path?: string,
  ) {
    super(message);
    this.name = "IsolationError";
  }
}

export class ConflictError extends IsolationError {
  constructor(public paths: string[], worktree: string) {
    super("conflict", `parent changed since snapshot, nothing applied (worktree kept at ${worktree}): ${paths.join(", ")}`, paths[0]);
    this.name = "ConflictError";
  }
}

const MAX_DIFF = 100_000;
const DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];
// hooks off: isolation plumbing must not run user hooks
const QUIET = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
// Git worktree add inspects sibling admin directories, which must be fully created.
const worktreeAdds = new Map<string, Promise<Uint8Array>>();
const snapRef = (id: string) => `refs/pi-subagents/${id}/snapshot`;

const MAX_STDERR = 64 * 1024;

interface Out { code: number; out: Uint8Array; err: string; omitted: number }

async function run(cwd: string, args: string[], input?: Uint8Array, maxChars?: number): Promise<Out> {
  // node:child_process, not Bun.spawn: Pi loads extensions under Node.
  return new Promise((resolve, reject) => {
    const fail = (e: Error) => reject(new IsolationError("missing", `cannot run git in ${cwd}: ${e.message}`, cwd));
    const proc = spawn("git", args, {
      cwd,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let total = 0, kept = 0;
    const limit = maxChars ?? Infinity;
    if (maxChars !== undefined) proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (d: Buffer | string) => {
      if (typeof d !== "string") out.push(d);
      else {
        // Keep draining for accurate omission counts, retaining only the display prefix.
        if (total < limit) {
          let prefix = d.slice(0, limit - total);
          // Do not turn a UTF-16 boundary inside an astral character into U+FFFD.
          if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
          out.push(Buffer.from(prefix));
          kept += prefix.length;
        }
        total += d.length;
      }
    });
    let errBytes = 0;
    proc.stderr!.on("data", (d: Buffer) => {
      if (errBytes >= MAX_STDERR) return; // keep draining so git never blocks, retain only the head
      const room = d.subarray(0, MAX_STDERR - errBytes);
      err.push(room);
      errBytes += room.length;
    });
    proc.on("error", fail);
    proc.on("close", (code) =>
      resolve({ code: code ?? 1, out: Buffer.concat(out), err: Buffer.concat(err).toString().trim(), omitted: total - kept }));
    if (input) {
      proc.stdin!.on("error", () => {}); // git may exit before reading everything
      proc.stdin!.end(input);
    }
  });
}

async function git(cwd: string, args: string[], input?: Uint8Array): Promise<Uint8Array> {
  const r = await run(cwd, args, input);
  if (r.code !== 0) throw new IsolationError("git", `git ${args[0]} failed: ${r.err}`, cwd);
  return r.out;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const gitText = async (cwd: string, args: string[]) => text(await git(cwd, args)).trim();
const nulList = (b: Uint8Array) => text(b).split("\0").filter(Boolean);

async function exists(p: string): Promise<boolean> {
  try { await lstat(p); return true; } catch { return false; }
}

/**
 * Worktree goes in <gitCommonDir>/pi-subagents/<id> by default: invisible to the
 * parent's `git status`, on the same filesystem as the repo, scoped per repo (no
 * collisions in a shared tmp), and shared by linked worktrees of the same repo.
 */
/** Top-level directory of the repository containing cwd. */
export async function repoRootOf(cwd: string): Promise<string> {
  const r = await run(cwd, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) throw new IsolationError("git", `not a git repository: ${cwd}`, cwd);
  return realpath(text(r.out).trim());
}

export async function create(opts: { repoRoot: string; id: string; baseDir?: string }): Promise<Workspace> {
  const { id } = opts;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes("..") || id.endsWith(".lock")) {
    throw new IsolationError("git", `invalid workspace id: ${id}`);
  }
  const probe = await run(opts.repoRoot, ["rev-parse", "--show-toplevel"]);
  if (probe.code !== 0) throw new IsolationError("git", `not a git repository: ${opts.repoRoot}`, opts.repoRoot);
  const repoRoot = await realpath(text(probe.out).trim());
  const head = await run(repoRoot, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (head.code !== 0) throw new IsolationError("git", `repository has no commits: ${repoRoot}`, repoRoot);
  const baseCommit = text(head.out).trim();
  const common = await realpath(await gitText(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const baseDir = opts.baseDir ?? join(common, "pi-subagents");
  const path = join(baseDir, id);
  const branch = `pi-subagent/${id}`;
  await mkdir(baseDir, { recursive: true });
  const previous = worktreeAdds.get(common) ?? Promise.resolve();
  const adding = previous.catch(() => {}).then(() =>
    git(repoRoot, [...QUIET, "worktree", "add", "-q", "-b", branch, path, baseCommit]));
  worktreeAdds.set(common, adding);
  try { await adding; }
  finally { if (worktreeAdds.get(common) === adding) worktreeAdds.delete(common); }
  const ws: Workspace = { id, repoRoot, path, branch, baseCommit };

  try {
    await carry(repoRoot, path);
    await git(path, ["add", "-A"]);
    await git(path, [...QUIET, "-c", "user.name=pi-subagents", "-c", "user.email=pi-subagents@localhost",
      "commit", "-q", "--allow-empty", "--no-verify", "-m", "pi-subagents snapshot"]);
    await git(repoRoot, ["update-ref", snapRef(id), await gitText(path, ["rev-parse", "HEAD"])]);
  } catch (e) {
    throw new IsolationError("carry", `${(e as Error).message}; ${await cleanupHalf(ws)}`, path);
  }
  return ws;
}

// Copy the parent's uncommitted work into the worktree.
async function carry(repoRoot: string, wt: string): Promise<void> {
  const patch = await git(repoRoot, ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--src-prefix=a/", "--dst-prefix=b/"]);
  if (patch.length) await git(wt, ["apply", "--index", "--binary"], patch);
  const untracked = nulList(await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]));
  for (const rel of untracked) {
    if (rel.endsWith("/")) continue; // nested repo
    const src = join(repoRoot, rel), dst = join(wt, rel);
    const st = await lstat(src);
    await mkdir(dirname(dst), { recursive: true });
    if (st.isSymbolicLink()) await symlink(await readlink(src), dst);
    else if (st.isFile()) { await copyFile(src, dst); await chmod(dst, st.mode & 0o777); }
  }
}

// Remove a half-created worktree only if it is provably untouched; else keep it.
async function cleanupHalf(ws: Workspace): Promise<string> {
  try {
    const status = await git(ws.path, ["status", "--porcelain", "-z", "--ignored"]);
    const head = await gitText(ws.path, ["rev-parse", "HEAD"]);
    if (status.length === 0 && head === ws.baseCommit) {
      await git(ws.repoRoot, ["worktree", "remove", ws.path]);
      await git(ws.repoRoot, ["branch", "-D", ws.branch]);
      return "unmodified worktree removed";
    }
  } catch { /* fall through to keep */ }
  return `worktree kept at ${ws.path} (branch ${ws.branch})`;
}

async function snapshotOf(ws: Workspace): Promise<string> {
  if (!(await exists(ws.path))) throw new IsolationError("missing", `worktree missing: ${ws.path}`, ws.path);
  const r = await run(ws.repoRoot, ["rev-parse", "--verify", "-q", `${snapRef(ws.id)}^{commit}`]);
  if (r.code !== 0) throw new IsolationError("missing", `snapshot ref missing for ${ws.id}`, ws.path);
  return text(r.out).trim();
}

// Freeze the staged tree once so filenames and patch describe the same content.
async function changesOf(ws: Workspace): Promise<{ snap: string; tree: string; changed: string[] }> {
  const snap = await snapshotOf(ws);
  await git(ws.path, ["add", "-A"]);
  const tree = await gitText(ws.path, ["write-tree"]);
  const changed = nulList(await git(ws.path, [...DIFF, "--name-only", "-z", snap, tree]));
  return { snap, tree, changed };
}

/** Agent changes only: worktree vs the snapshot taken at create. Stages files in the worktree index. */
export async function inspect(ws: Workspace): Promise<{ changed: string[]; diff: string; clean: boolean }> {
  const { snap, tree, changed } = await changesOf(ws);
  const r = await run(ws.path, [...DIFF, snap, tree], undefined, MAX_DIFF);
  if (r.code !== 0) throw new IsolationError("git", `git diff failed: ${r.err}`, ws.path);
  const diff = text(r.out) + (r.omitted ? `\n[diff truncated: ${r.omitted} characters omitted]\n` : "");
  return { changed, diff, clean: changed.length === 0 };
}

// Parent paths that no longer match the snapshot (content, exec bit, or type).
async function diverged(ws: Workspace, snap: string, paths: string[]): Promise<string[]> {
  const want = new Map<string, string>(); // path -> "mode sha"
  for (let i = 0; i < paths.length; i += 200) {
    const out = await git(ws.repoRoot, ["ls-tree", "-z", snap, "--", ...paths.slice(i, i + 200)]);
    for (const rec of nulList(out)) {
      const tab = rec.indexOf("\t");
      const meta = rec.slice(0, tab), name = rec.slice(tab + 1);
      const [mode, , sha] = meta.split(" ");
      want.set(name, `${mode} ${sha}`);
    }
  }
  const bad: string[] = [];
  for (const p of paths) {
    const abs = join(ws.repoRoot, p);
    let have: string | undefined;
    try {
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        const sha = text(await git(ws.repoRoot, ["hash-object", "--stdin"], new TextEncoder().encode(await readlink(abs)))).trim();
        have = `120000 ${sha}`;
      } else if (st.isFile()) {
        const sha = (await gitText(ws.repoRoot, ["hash-object", "--", p]));
        // Windows has no exec bit (and may check symlinks out as plain files): trust the snapshot's mode there.
        const wantMode = want.get(p)?.split(" ")[0];
        const kept = process.platform === "win32" && (wantMode === "100755" || wantMode === "120000");
        have = `${kept ? wantMode : st.mode & 0o111 ? "100755" : "100644"} ${sha}`;
      } else have = "other";
    } catch { have = undefined; } // absent (or parent is not a directory)
    if (have !== want.get(p)) bad.push(p);
  }
  return bad;
}

/** Apply the agent's patch to the parent tree. Throws ConflictError if touched files diverged; changes nothing on failure. */
export async function apply(ws: Workspace): Promise<{ applied: string[] }> {
  if (!(await exists(ws.repoRoot))) throw new IsolationError("missing", `repo missing: ${ws.repoRoot}`, ws.repoRoot);
  const top = await run(ws.repoRoot, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || (await realpath(text(top.out).trim())) !== (await realpath(ws.repoRoot))) {
    throw new IsolationError("git", `target is not the workspace's repo: ${ws.repoRoot}`, ws.repoRoot);
  }
  const { snap, tree, changed: applied } = await changesOf(ws);
  if (applied.length === 0) return { applied };
  const bad = await diverged(ws, snap, applied);
  if (bad.length) throw new ConflictError(bad, ws.path);
  const patch = await git(ws.path, [...DIFF, "--binary", snap, tree]);
  try {
    await git(ws.repoRoot, ["apply", "--check", "--binary"], patch);
    await git(ws.repoRoot, ["apply", "--binary"], patch);
  } catch (e) {
    throw new IsolationError("git", `${(e as Error).message}; worktree and branch kept at ${ws.path}`, ws.path);
  }
  return { applied };
}

/** Remove worktree, branch and snapshot ref. Refuses if the agent changed anything unless force. Stops at the first git failure. */
export async function discard(ws: Workspace, opts: { force?: boolean } = {}): Promise<void> {
  if (await exists(ws.path)) {
    if (!opts.force && (await changesOf(ws)).changed.length !== 0) {
      throw new IsolationError("dirty", `worktree has changes, use force to discard: ${ws.path}`, ws.path);
    }
    await git(ws.repoRoot, ["worktree", "remove", "--force", ws.path]);
  } else {
    await git(ws.repoRoot, ["worktree", "prune"]);
  }
  try {
    await git(ws.repoRoot, ["branch", "-D", ws.branch]);
    await git(ws.repoRoot, ["update-ref", "-d", snapRef(ws.id)]);
  } catch (e) {
    throw new IsolationError("git", `${(e as Error).message}; leftover branch ${ws.branch}`, ws.path);
  }
}
