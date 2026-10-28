// Delegation benchmark against a zero-delay fake provider. Usage: bun bench/delegation.ts [runs=10]
// Launch latency uses RpcConnection with the runner's own buildArgs (runner.start does not expose ack/first-event timing);
// end-to-end and cancel-all use createRunner itself.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { BASE_FLAGS, descendants, f, fakeProvider, makeAgentDir, pct, row, spawnToState, stopPi, rssMb } from "./lib.ts";
import { RpcConnection } from "../src/protocol.ts";
import { resolvePiCommand } from "../src/pi-command.ts";
import { buildArgs, createRunner } from "../src/runner.ts";
import type { RunSpec } from "../src/types.ts";

const N = Number(process.argv[2] ?? 10);
const LEVELS = [1, 2, 4, 8];
const ok = fakeProvider("text");
const hang = fakeProvider("hang");
const dir = makeAgentDir(ok.port);
const hangDir = makeAgentDir(hang.port);
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_TELEMETRY = "0";
const cwd = tmpdir();
const spec: RunSpec = {
  cwd,
  task: "say something",
  systemPrompt: "You are a bench agent.",
  model: "fake/fake-model",
  trusted: false,
  timeoutMs: 60_000,
  launchTimeoutMs: 30_000,
};

/** Sum of RSS over all processes below this bench process, sampled until stop(). */
function peakRss() {
  let peak = 0;
  const t = setInterval(() => {
    peak = Math.max(
      peak,
      descendants(process.pid).reduce((s, p) => s + rssMb(p), 0),
    );
  }, 25);
  return { stop: () => (clearInterval(t), peak) };
}

async function launchOne() {
  const cmd = resolvePiCommand();
  const t0 = performance.now();
  const child = spawn(cmd.command, [...cmd.args, ...buildArgs(spec)], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let firstEvent = NaN;
  const conn = new RpcConnection(child, {
    onEvent: () => {
      if (Number.isNaN(firstEvent)) firstEvent = performance.now() - t0;
    },
    onProtocolError: () => {},
  });
  const ack = await conn.send({ type: "prompt", message: spec.task }, 30_000);
  const ackMs = performance.now() - t0;
  if (!ack.success) throw new Error("prompt rejected");
  while (Number.isNaN(firstEvent)) await Bun.sleep(1);
  await stopPi(child, conn);
  return { ackMs, firstEvent };
}

console.log(`runs per level=${N}`);
console.log("\nbaseline: direct minimal RPC (spawn -> get_state, same isolation flags)");
const base: number[] = [];
for (let i = 0; i < N; i++) {
  const r = await spawnToState([...BASE_FLAGS, "--no-extensions", "--tools", "read,grep,find,ls"], process.env);
  base.push(r.ms);
  await stopPi(r.child, r.conn);
}
const baseS = row("spawn->get_state", base);

console.log("\nlaunch latency, sequential (1 child): start -> prompt ack, start -> first event");
const ack1: number[] = [],
  ev1: number[] = [];
for (let i = 0; i < N; i++) {
  const r = await launchOne();
  ack1.push(r.ackMs);
  ev1.push(r.firstEvent);
}
const ackS = row("start->ack", ack1);
const evS = row("start->first event", ev1);

const out: any = { base: baseS, ack: ackS, ev: evS, levels: {} };
for (const n of LEVELS) {
  const acks: number[] = [],
    evs: number[] = [],
    e2e: number[] = [],
    rss: number[] = [];
  for (let i = 0; i < N; i++) {
    // launch latency with n concurrent children
    const pk = peakRss();
    const rs = await Promise.all(Array.from({ length: n }, () => launchOne()));
    rss.push(pk.stop());
    acks.push(...rs.map((r) => r.ackMs));
    evs.push(...rs.map((r) => r.firstEvent));
    // end-to-end through the real runner
    const runner = createRunner({ graceMs: 2000 });
    const t0 = performance.now();
    const results = await Promise.all(
      Array.from({ length: n }, () => {
        const c = runner.start(spec);
        return c.done.then((r) => {
          if (r.status !== "completed") throw new Error(JSON.stringify(r));
          return performance.now() - t0;
        });
      }),
    );
    e2e.push(...results);
  }
  console.log(`\nconcurrency ${n}`);
  const a = row("start->ack", acks),
    e = row("start->first event", evs),
    d = row("end-to-end (runner, per child)", e2e);
  const peak = Math.max(...rss);
  console.log(`peak RSS sum of children: max=${f(peak)}MB median=${f(pct(rss, 0.5))}MB (${f(peak / n)}MB per child)`);
  out.levels[n] = { ack: a, ev: e, e2e: d, peakRssMb: peak };
}

console.log("\nshutdown: cancel all (children blocked on a hanging model request)");
process.env.PI_CODING_AGENT_DIR = hangDir;
for (const n of LEVELS) {
  const sh: number[] = [];
  for (let i = 0; i < Math.min(N, 5); i++) {
    const runner = createRunner({ graceMs: 2000 });
    const before = hang.bodies.length;
    const kids = Array.from({ length: n }, () => runner.start({ ...spec, timeoutMs: 60_000 }));
    for (let k = 0; k < 300 && hang.bodies.length - before < n; k++) await Bun.sleep(50);
    const t0 = performance.now();
    await Promise.all(kids.map((k) => k.cancel()));
    sh.push(performance.now() - t0);
    const rs = await Promise.all(kids.map((k) => k.done));
    if (rs.some((r) => r.status !== "cancelled")) throw new Error("not cancelled");
    if (descendants(process.pid).length) throw new Error("leaked processes");
  }
  out.levels[n].cancel = row(`cancel-all x${n} (all cancelled, 0 leaks)`, sh);
}
console.log("\nJSON " + JSON.stringify(out));
void ok.server.stop(true);
void hang.server.stop(true);
process.exit(0);
