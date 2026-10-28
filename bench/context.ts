// Cold context overhead: first request body a real parent Pi sends to the fake provider, with and without the extension.
// Usage: bun bench/context.ts
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_FLAGS, EXT, PI, fakeProvider, makeAgentDir, spawnToState, stopPi } from "./lib.ts";

const OFFICIAL = join(homedir(), ".pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts");
const fake = fakeProvider("text");
const dir = makeAgentDir(fake.port);
const env = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_TELEMETRY: "0" };
const cwd = join(tmpdir(), "pi-bench-ctx-cwd");
Bun.spawnSync(["mkdir", "-p", cwd]);

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null));
async function firstBody(extra: string[]) {
  fake.bodies.length = 0;
  const r = await spawnToState([...BASE_FLAGS, "--model", "fake/fake-model", ...extra], env, cwd);
  if (!r.ok) throw new Error("rpc failed " + extra.join(" "));
  await r.conn.send({ type: "prompt", message: "hi" }, 30_000);
  for (let i = 0; i < 200 && fake.bodies.length === 0; i++) await Bun.sleep(50);
  await stopPi(r.child, r.conn);
  const b = fake.bodies[0];
  if (!b) throw new Error("no request captured for " + extra.join(" "));
  const sys = b.messages.filter((m: any) => m.role === "system" || m.role === "developer");
  return { tools: b.tools ?? [], toolBytes: bytes(b.tools), sysBytes: bytes(sys.map((m: any) => m.content)) - 2 - (sys.length - 1), body: bytes(b), names: (b.tools ?? []).map((t: any) => t.function.name) };
}

const bare = await firstBody(["--no-extensions"]);
const mine = await firstBody(["--no-extensions", "-e", EXT]);
let official: Awaited<ReturnType<typeof firstBody>> | undefined;
if (existsSync(OFFICIAL)) {
  try { official = await firstBody(["--no-extensions", "-e", OFFICIAL]); } catch (e) { console.log("official example did not load standalone:", (e as Error).message); }
} else console.log("official example not found at", OFFICIAL);

const tok = (b: number) => `~${Math.round(b / 4)} tok`;
console.log("ESTIMATE: tokens = bytes/4 (rough heuristic, not a tokenizer count)\n");
console.log("variant".padEnd(24), "tools".padStart(7), "sys".padStart(7), "body".padStart(7), " added(tools+sys)");
const line = (n: string, x: typeof bare, base?: typeof bare) => {
  const d = base ? x.toolBytes - base.toolBytes + (x.sysBytes - base.sysBytes) : 0;
  console.log(n.padEnd(24), String(x.toolBytes).padStart(7), String(x.sysBytes).padStart(7), String(x.body).padStart(7), base ? ` ${d} B (${tok(d)}); tools +${x.toolBytes - base.toolBytes} B, sys +${x.sysBytes - base.sysBytes} B` : "");
};
line("bare pi (builtins)", bare);
line("this extension", mine, bare);
if (official) line("official example", official, bare);
console.log("\ntool names bare:", bare.names.join(","));
console.log("tool names ext :", mine.names.join(","));
if (official) console.log("tool names off.:", official.names.join(","));
const added = mine.tools.filter((t: any) => !bare.names.includes(t.function.name));
console.log("\nadded tool JSON:", JSON.stringify(added));
console.log("\nJSON " + JSON.stringify({ bare: { t: bare.toolBytes, s: bare.sysBytes }, mine: { t: mine.toolBytes, s: mine.sysBytes }, official: official && { t: official.toolBytes, s: official.sysBytes } }));
fake.server.stop(true);
process.exit(0);
