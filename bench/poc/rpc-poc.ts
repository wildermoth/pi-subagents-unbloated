// RPC backend PoC: spawn `pi --mode rpc`, measure startup/state/shutdown/RSS. No model calls.
// Usage: bun bench/poc/rpc-poc.ts [iterations] [--full]   (--full = no isolation flags, for comparison)
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";

const N = Number(process.argv[2] ?? 20);
const FULL = process.argv.includes("--full");
const PI = process.env.PI_BIN ?? "pi";
const ISOLATED = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
  "--no-context-files", "--offline", "--tools", "read,grep,find,ls", "--no-session",
  "--append-system-prompt", "You are a PoC subagent."];
const args = ["--mode", "rpc", ...(FULL ? ["--no-session"] : ISOLATED)];

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)];
const rssMb = (pid: number) => {
  try { return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]) / 1024; } catch { return NaN; }
};
// pi is a shell launcher -> node: sum RSS over the process tree
const treeRssMb = (pid: number): number => {
  let sum = rssMb(pid);
  try {
    for (const c of readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean)) sum += treeRssMb(Number(c));
  } catch {}
  return sum;
};

// Strict LF-only JSONL reader (no readline: it splits on U+2028/2029)
function onRecords(child: ChildProcessWithoutNullStreams, cb: (r: any) => void) {
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line) cb(JSON.parse(line));
    }
  });
}

async function once() {
  const t0 = performance.now();
  const child = spawn(PI, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.stderr.resume();
  let firstOut = NaN;
  let resolveState!: (v: number) => void;
  const stateP = new Promise<number>((r) => (resolveState = r));
  onRecords(child, (rec) => {
    if (Number.isNaN(firstOut)) firstOut = performance.now() - t0;
    if (rec.type === "response" && rec.id === "s1") resolveState(performance.now() - t0);
  });
  // Commands sent immediately are buffered by the pipe until pi reads stdin
  child.stdin.write(JSON.stringify({ id: "s1", type: "get_state" }) + "\n");
  const getState = await stateP;
  const rss = treeRssMb(child.pid!);
  const t1 = performance.now();
  child.stdin.end(); // graceful: close stdin
  await exited;
  const graceful = performance.now() - t1;
  return { firstOut, getState, rss, graceful };
}

async function forcedKill() {
  const child = spawn(PI, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const ready = new Promise<void>((r) => onRecords(child, (x) => x.id === "k" && r()));
  child.stdin.write(JSON.stringify({ id: "k", type: "get_state" }) + "\n");
  await ready;
  const t = performance.now();
  child.kill("SIGKILL");
  await exited;
  return performance.now() - t;
}

const rows: Awaited<ReturnType<typeof once>>[] = [];
const kills: number[] = [];
for (let i = 0; i < N; i++) { rows.push(await once()); kills.push(await forcedKill()); }
const col = (k: keyof (typeof rows)[0]) => rows.map((r) => r[k]);
const fmt = (n: string, xs: number[], u = "ms") => console.log(`${n.padEnd(28)} p50=${pct(xs, .5).toFixed(1)}${u} p95=${pct(xs, .95).toFixed(1)}${u}`);
console.log(`mode=${FULL ? "full" : "isolated"} n=${N} args=${args.join(" ")}`);
fmt("spawn->first stdout", col("firstOut"));
fmt("spawn->get_state resp", col("getState"));
fmt("stdin-close->exit", col("graceful"));
fmt("SIGKILL->exit", kills);
fmt("RSS tree (at get_state)", col("rss"), "MB");
