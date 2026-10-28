/**
 * In-process Pi SDK child PoC + benchmark. No paid model: a local fake
 * OpenAI-compatible server stands in (hang / tool-call modes).
 * Run: bun bench/poc/sdk-poc.ts   |   node --expose-gc bench/poc/sdk-poc.ts
 * Modes: (none)=full bench, --import-only (prints cold import ms)
 */
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const SDK = process.env.PI_SDK ??
  `${process.env.HOME}/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js`;
const N = 20;
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))]!;
const stat = (a: number[]) => `p50=${q(a, 0.5).toFixed(1)}ms p95=${q(a, 0.95).toFixed(1)}ms`;
const gc = () => { (globalThis as any).gc?.(); (globalThis as any).Bun?.gc(true); };

const t0 = performance.now();
const sdk: any = await import(SDK);
const importMs = performance.now() - t0;
if (process.argv.includes("--import-only")) { console.log(importMs.toFixed(1)); process.exit(0); }
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;

// --- fake provider -------------------------------------------------------
let mode: "hang" | "tool" = "hang";
const server = createServer((req, res) => {
  req.resume();
  if (mode === "hang") return; // never answer
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta: any, finish: string | null) =>
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function",
    function: { name: "bash", arguments: JSON.stringify({ command: "sleep 301 & sleep 301 & wait" }) } }] }, null);
  chunk({}, "tool_calls");
  res.write("data: [DONE]\n\n"); // then keep socket open
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
// --- shared (once) vs per-session ---------------------------------------
const agentDir = mkdtempSync(join(tmpdir(), "poc-agent-"));       // isolated: never touches ~/.pi
const tm = performance.now();
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fakeprov: {
  baseUrl, api: "openai-completions", apiKey: "k", models: [{ id: "fake", contextWindow: 8000, maxTokens: 1000 }] } } }));
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"), refreshOnCreate: false });
const model = modelRuntime.getModel("fakeprov", "fake");
if (!model) throw new Error("fake model not registered");
const runtimeMs = performance.now() - tm;

async function child(cwd: string) {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    appendSystemPrompt: ["You are a child agent. Reply tersely."],
  });
  await resourceLoader.reload();
  return createAgentSession({
    cwd, agentDir, model, thinkingLevel: "off", modelRuntime, resourceLoader, settingsManager,
    tools: ["read", "grep", "find", "ls", "bash"],
    sessionManager: SessionManager.inMemory(cwd),
  });
}

const create: number[] = [], dispose: number[] = [];
for (let i = 0; i < N; i++) {
  const a = performance.now();
  const { session } = await child(process.cwd());
  const b = performance.now();
  session.dispose();
  dispose.push(performance.now() - b); create.push(b - a);
  if (i === 0) {
    console.log("tools:", session.getActiveToolNames().join(","));
    console.log("prompt tail:", JSON.stringify(session.systemPrompt.slice(-120)));
  }
}

// memory per live session
const mem: Record<number, [number, number]> = {};
for (const k of [1, 4, 8, 64]) {
  gc(); const h0 = process.memoryUsage();
  const ss = []; for (let i = 0; i < k; i++) ss.push((await child(process.cwd())).session);
  gc(); const h1 = process.memoryUsage();
  mem[k] = [(h1.heapUsed - h0.heapUsed) / k / 1e6, (h1.rss - h0.rss) / k / 1e6];
  ss.forEach((s) => s.dispose()); gc();
}

// --- abort paths ---------------------------------------------------------
const pgrep = () => { try { return execSync("pgrep -f '^sleep 301'", { encoding: "utf8" }).trim().split("\n").filter(Boolean).length; } catch { return 0; } };
async function abortTest(m: "hang" | "tool", wait: (s: any) => Promise<void>, how: "abort" | "dispose") {
  mode = m;
  const { session } = await child(process.cwd());
  let pending: Promise<any> = session.prompt("go").then(() => "resolved", (e: any) => "rejected:" + e.message);
  await wait(session);
  if (m === "tool") await new Promise((r) => setTimeout(r, 500)); // let bash spawn
  const aliveBefore = pgrep();
  const a = performance.now();
  if (how === "abort") await session.abort(); else session.dispose();
  const ms = performance.now() - a;
  const outcome = await Promise.race([pending, new Promise((r) => setTimeout(() => r("STILL PENDING after 2s"), 2000))]);
  const alive = pgrep();
  const last = session.messages.at(-1) as any;
  if (how === "abort") session.dispose();
  return { m, how, sleepProcsAliveBeforeAbort: aliveBefore, ms: +ms.toFixed(1), outcome, sleepProcsAlive: alive, lastMsg: last?.role + "/" + (last?.stopReason ?? "") };
}
const waitEvent = (type: string) => (s: any) => new Promise<void>((r) => { const u = s.subscribe((e: any) => { if (e.type === type) { u(); r(); } }); });
const sleep = (ms: number) => () => new Promise<void>((r) => setTimeout(r, ms));
const results = [];
results.push(await abortTest("hang", sleep(300), "abort"));
results.push(await abortTest("tool", waitEvent("tool_execution_start"), "abort"));
await new Promise((r) => setTimeout(r, 500)); results.at(-1)!.sleepProcsAliveAfter500ms = pgrep();
try { execSync("pkill -f '^sleep 301'"); } catch {}
results.push(await abortTest("tool", waitEvent("tool_execution_start"), "dispose"));
await new Promise((r) => setTimeout(r, 500)); results.at(-1)!.sleepProcsAliveAfter500ms = pgrep();
try { execSync("pkill -f '^sleep 301'"); } catch {}

// cwd per session
const cwdA = mkdtempSync(join(tmpdir(), "poc-a-"));
mode = "hang";
const { session: sa } = await child(cwdA);
const cwdSeen = { processCwd: process.cwd(), sessionCwd: sa.sessionManager.getCwd?.() ?? "n/a" };
sa.dispose();

console.log(JSON.stringify({ runtime: (globalThis as any).Bun ? "bun " + Bun.version : "node " + process.version,
  coldImportMs: +importMs.toFixed(1), modelRuntimeCreateOnceMs: +runtimeMs.toFixed(1),
  create: stat(create), dispose: stat(dispose),
  memPerSession_MB_heap_rss: mem, results, cwdSeen }, null, 1));
server.closeAllConnections?.(); server.close(); process.exit(0);
