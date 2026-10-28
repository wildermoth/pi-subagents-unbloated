/** RPC child baseline: spawn pi --mode rpc, time to first get_state response, RSS of child, kill time. */
import { spawn, execSync } from "node:child_process";
const N = 20;
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))]!;
const args = ["--mode", "rpc", "--no-session", "-ne", "-ns", "-np", "--no-themes", "-nc", "-t", "read,grep,find,ls,bash", "--append-system-prompt", "Reply tersely."];
const ready: number[] = [], kill: number[] = [], rss: number[] = [];
for (let i = 0; i < N; i++) {
  const t = performance.now();
  const p = spawn("pi", args, { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((res) => {
    p.stdout!.on("data", (d) => { if (String(d).includes('"get_state"')) res(); });
    p.stdin!.write(JSON.stringify({ id: "1", type: "get_state" }) + "\n");
  });
  ready.push(performance.now() - t);
  try { // pi is a sh launcher that execs/forks node; sum RSS of the tree
    rss.push(+execSync(`ps -o rss= --ppid ${p.pid} -p ${p.pid} | awk '{s+=$1} END {print s/1024}'`, { encoding: "utf8" }));
  } catch {}
  const k = performance.now();
  const exited = new Promise((r) => p.on("exit", r));
  p.kill("SIGTERM"); await exited; kill.push(performance.now() - k);
}
const f = (a: number[]) => `p50=${q(a, .5).toFixed(0)} p95=${q(a, .95).toFixed(0)}`;
console.log({ spawnToGetStateMs: f(ready), sigtermToExitMs: f(kill), childTreeRssMB: f(rss) });
