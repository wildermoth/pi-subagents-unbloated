// Startup benchmark. Usage: bun bench/startup.ts [runs=20]   (internal: --child)
// (1) extension import + factory cost in fresh bun processes, (2) pi --mode rpc spawn->get_state with/without the extension,
// (3) idle resources (stub timers/handles, child processes).
import { stat, BASE_FLAGS, EXT, PI, ROOT, descendants, f, makeAgentDir, row, spawnToState, stopPi } from "./lib.ts";

if (process.argv.includes("--child")) {
  // Runs inside a fresh bun process: time the import, then the factory with a stub pi.
  const t0 = performance.now();
  const mod = await import(EXT);
  const importMs = performance.now() - t0;
  const timers: string[] = [];
  const orig = { st: globalThis.setTimeout, si: globalThis.setInterval, sim: globalThis.setImmediate };
  (globalThis as any).setTimeout = (...a: any[]) => (timers.push("setTimeout"), (orig.st as any)(...a));
  (globalThis as any).setInterval = (...a: any[]) => (timers.push("setInterval"), (orig.si as any)(...a));
  (globalThis as any).setImmediate = (...a: any[]) => (timers.push("setImmediate"), (orig.sim as any)(...a));
  const calls: string[] = [];
  const stub = new Proxy({}, { get: (_t, k) => (...a: any[]) => { calls.push(String(k)); return undefined; } });
  const hb = (process as any)._getActiveHandles?.().length ?? -1;
  const t1 = performance.now();
  mod.default(stub);
  const factoryMs = performance.now() - t1;
  const ha = (process as any)._getActiveHandles?.().length ?? -1;
  Object.assign(globalThis, { setTimeout: orig.st, setInterval: orig.si, setImmediate: orig.sim });
  console.log(JSON.stringify({ importMs, factoryMs, timers: timers.length, handlesDelta: ha - hb, calls, children: descendants(process.pid).length }));
  process.exit(0);
}

const N = Number(process.argv[2] ?? 20);
console.log(`runs=${N} pi=${PI}`);

// (1) fresh-process import + factory
const imp: number[] = [], fac: number[] = [];
let last: any;
for (let i = 0; i < N; i++) {
  const p = Bun.spawnSync([process.execPath, import.meta.path, "--child"], { cwd: ROOT });
  last = JSON.parse(p.stdout.toString().trim().split("\n").at(-1)!);
  imp.push(last.importMs); fac.push(last.factoryMs);
  if (last.timers || last.children) throw new Error("idle violation: " + JSON.stringify(last));
}
console.log("\n(1) extension cost (fresh bun process, includes loading typebox + pi-ai from node_modules)");
const impS = row("import src/index.ts (cold)", imp);
const facS = row("factory(stubPi)", fac);
console.log(`factory calls: ${last.calls.join(",")}; timers created=${last.timers}; handle delta=${last.handlesDelta}; child procs=${last.children}`);

// (2) pi spawn -> get_state
const dir = makeAgentDir();
const env = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_TELEMETRY: "0" };
const variants: Record<string, string[]> = {
  "--no-extensions (bare)": [...BASE_FLAGS, "--no-extensions"],
  "-e src/index.ts": [...BASE_FLAGS, "--no-extensions", "-e", EXT],
};
// warm the disk cache / first-run work, not recorded
for (const a of Object.values(variants)) { const w = await spawnToState(a, env); await stopPi(w.child, w.conn); }
const res: Record<string, number[]> = {};
let extDesc = -1, bareDesc = -1;
for (const k of Object.keys(variants)) res[k] = [];
for (let i = 0; i < N; i++) {
  // interleave variants to cancel drift
  for (const [k, a] of Object.entries(variants)) {
    const r = await spawnToState(a, env);
    if (!r.ok) throw new Error("get_state failed for " + k);
    res[k]!.push(r.ms);
    if (i === 0) { const d = descendants(r.child.pid!).length; if (k.startsWith("-e")) extDesc = d; else bareDesc = d; }
    await stopPi(r.child, r.conn);
  }
}
console.log("\n(2) pi --mode rpc spawn -> get_state response");
const bare = row("--no-extensions", res["--no-extensions (bare)"]!);
const ext = row("-e src/index.ts", res["-e src/index.ts"]!);
console.log(`delta p50=${f(ext.p50 - bare.p50)}ms p95=${f(ext.p95 - bare.p95)}ms (p95 of paired diffs below)`);
const diffs = res["-e src/index.ts"]!.map((v, i) => v - res["--no-extensions (bare)"]![i]!);
row("paired diff (ext - bare)", diffs);
// sanity: the extension really loads (its tool shows up in get_commands/state)
{ const r = await spawnToState(variants["-e src/index.ts"]!, env); const c = await r.conn.send({ type: "get_commands" }, 10000); console.log("extension loaded (subagents command present):", JSON.stringify(c).includes("subagents")); await stopPi(r.child, r.conn); }

// (3) idle: descendants of idle pi (launcher chain counted equally in both)
console.log("\n(3) idle resources");
console.log(`pi descendant processes at idle: bare=${bareDesc} with-extension=${extDesc} (delta ${extDesc - bareDesc}); stub timers=${last.timers}; stub child procs=${last.children}`);
console.log("\nJSON " + JSON.stringify({ imp: { p50: impS.p50, p95: impS.p95 }, fac: { p50: facS.p50, p95: facS.p95 }, bare, ext, pairedP50: stat(diffs).p50, extDesc, bareDesc }));
