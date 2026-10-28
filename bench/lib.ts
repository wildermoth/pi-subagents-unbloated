// Shared helpers for the benchmarks: stats, procfs sampling, isolated Pi agent dir, fake OpenAI-compatible provider.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcConnection } from "../src/protocol.ts";

export const ROOT = join(import.meta.dir, "..");
export const EXT = join(ROOT, "src", "index.ts");
export const PI = process.env.PI_BIN ?? "pi";

export const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))]!;
export const stat = (xs: number[]) => ({ p50: pct(xs, 0.5), p95: pct(xs, 0.95), min: Math.min(...xs), max: Math.max(...xs) });
export const f = (n: number, d = 1) => n.toFixed(d);
export const row = (name: string, xs: number[], unit = "ms") => {
  const s = stat(xs);
  console.log(`${name.padEnd(34)} p50=${f(s.p50)}${unit} p95=${f(s.p95)}${unit} min=${f(s.min)} max=${f(s.max)} n=${xs.length}`);
  return s;
};

export const rssMb = (pid: number) => {
  try {
    return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]) / 1024;
  } catch {
    return 0;
  }
};
export const childrenOf = (pid: number): number[] => {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
export const descendants = (pid: number): number[] => childrenOf(pid).flatMap((c) => [c, ...descendants(c)]);
export const treeRssMb = (pid: number) => [pid, ...descendants(pid)].reduce((s, p) => s + rssMb(p), 0);

export function makeAgentDir(fakePort?: number): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-bench-agent-"));
  mkdirSync(dir, { recursive: true });
  if (fakePort) {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          fake: {
            baseUrl: `http://127.0.0.1:${fakePort}/v1`,
            api: "openai-completions",
            apiKey: "dummy",
            models: [
              {
                id: "fake-model",
                name: "Fake",
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 2000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
  }
  return dir;
}

const chunk = (delta: object, finish: string | null = null, extra: object = {}) =>
  `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  })}\n\n`;
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

/** Zero-delay fake OpenAI-compatible provider. mode "hang" never answers. Records request bodies. */
export function fakeProvider(mode: "text" | "hang" = "text") {
  const bodies: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!req.url.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      bodies.push(await req.json());
      if (mode === "hang") return new Promise<Response>(() => {});
      return new Response(
        [
          chunk({ role: "assistant", content: "" }),
          chunk({ content: "fake answer" }),
          chunk({}, "stop", { usage }),
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { server, bodies, port: server.port! };
}

export const BASE_FLAGS = [
  "--mode",
  "rpc",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-mcp",
  "--no-context-files",
  "--offline",
  "--no-session",
];

/** Spawn pi with RpcConnection and wait for the get_state response; returns ms from spawn and the live handles. */
export async function spawnToState(args: string[], env: NodeJS.ProcessEnv, cwd = tmpdir()) {
  const t0 = performance.now();
  const child = spawn(PI, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const conn = new RpcConnection(child, { onEvent: () => {}, onProtocolError: () => {} });
  const r = await conn.send({ type: "get_state" }, 30_000);
  const ms = performance.now() - t0;
  return { ms, ok: r.success, child, conn };
}

export async function stopPi(child: ChildProcessWithoutNullStreams, conn: RpcConnection) {
  conn.closeInput();
  await Promise.race([conn.exited, Bun.sleep(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
