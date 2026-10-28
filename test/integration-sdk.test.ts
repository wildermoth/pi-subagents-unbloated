// Real Pi SDK, in process, against a local fake OpenAI-compatible server (no paid model).
// Run with PI_INTEGRATION=1 bun test test/integration-sdk.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgentDir, sse, startFakeServer, chunk, textReply, usage } from "./helpers/fake-provider.ts";
import { createSdkRunner } from "../src/sdk-runner.ts";
import type { RunSpec } from "../src/types.ts";

const enabled = process.env.PI_INTEGRATION === "1";
const T = (name: string, fn: () => Promise<void>) => test.skipIf(!enabled)(name, fn, 60_000);

type Reply = "text" | "tool-then-text" | "hang" | "http500";
let script: Reply = "text";
const bodies: any[] = [];
let server: ReturnType<typeof Bun.serve>;
let agentDir: string;
let work: string;
const savedEnv = { dir: process.env.PI_CODING_AGENT_DIR, tel: process.env.PI_TELEMETRY };

function handle(body: any): Response | Promise<Response> {
  switch (script) {
    case "text":
      return textReply("fake answer");
    case "tool-then-text":
      if (body.messages?.some((m: any) => m.role === "tool"))
        return textReply("file says: " + body.messages.findLast((m: any) => m.role === "tool").content);
      return sse([
        chunk({ role: "assistant", content: "" }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: join(work, "hello.txt") }) },
            },
          ],
        }),
        chunk({}, "tool_calls", { usage }),
      ]);
    case "http500":
      return new Response(JSON.stringify({ error: { message: "boom from fake", type: "server_error" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    case "hang":
      return new Promise<Response>(() => {});
  }
}

beforeAll(() => {
  if (!enabled) return;
  work = mkdtempSync(join(tmpdir(), "pi-sdk-work-"));
  writeFileSync(join(work, "hello.txt"), "SECRET-CONTENT-42");
  server = startFakeServer(handle, bodies);
  agentDir = makeAgentDir(server.port!);
  // Marker extension: proves extensions stay off for in-process agents.
  mkdirSync(join(agentDir, "extensions"));
  writeFileSync(
    join(agentDir, "extensions", "marker.ts"),
    `import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(join(agentDir, "marker"))}, "loaded"); }\n`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_TELEMETRY = "0";
});

afterAll(() => {
  void server?.stop(true);
  for (const [k, v] of [
    ["PI_CODING_AGENT_DIR", savedEnv.dir],
    ["PI_TELEMETRY", savedEnv.tel],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const spec = (o: Partial<RunSpec> = {}): RunSpec => ({
  cwd: work,
  task: "say something",
  systemPrompt: "You are a test agent.",
  model: "fake/fake-model",
  trusted: false,
  timeoutMs: 40_000,
  launchTimeoutMs: 20_000,
  inprocess: true,
  ...o,
});

T("completes against the real SDK with the agent prompt, and no extensions load", async () => {
  script = "text";
  bodies.length = 0;
  const r = await createSdkRunner().start(spec()).done;
  expect(r).toEqual({ status: "completed", text: "fake answer", truncated: false });
  expect(JSON.stringify(bodies[0].messages[0])).toContain("You are a test agent.");
  expect(existsSync(join(agentDir, "marker"))).toBe(false);
});

T("an allowed tool runs inside the session and its output reaches the model", async () => {
  script = "tool-then-text";
  const r = await createSdkRunner().start(spec({ tools: ["read"] })).done;
  expect(r.status).toBe("completed");
  expect(r.text).toContain("SECRET-CONTENT-42");
});

T("a provider HTTP error fails as a provider failure", async () => {
  script = "http500";
  const r = await createSdkRunner().start(spec()).done;
  expect(r).toMatchObject({ status: "failed", failure: { kind: "provider" } });
});

T("cancelling a hung request returns promptly", async () => {
  script = "hang";
  const child = createSdkRunner().start(spec());
  await new Promise((r) => setTimeout(r, 500));
  const t0 = performance.now();
  await child.cancel();
  expect((await child.done).status).toBe("cancelled");
  expect(performance.now() - t0).toBeLessThan(3000);
});

T("a hung request hits the run timeout", async () => {
  script = "hang";
  const r = await createSdkRunner().start(spec({ timeoutMs: 800 })).done;
  expect(r).toMatchObject({ status: "failed", failure: { kind: "timeout" } });
});

T("twenty in-process agents run at once and all finish", async () => {
  script = "text";
  const runner = createSdkRunner();
  const rss0 = process.memoryUsage().rss;
  const results = await Promise.all(Array.from({ length: 20 }, () => runner.start(spec()).done));
  expect(results.every((r) => r.status === "completed" && r.text === "fake answer")).toBe(true);
  const grownMb = (process.memoryUsage().rss - rss0) / 1e6;
  console.log(`20 in-process agents: rss grew ${grownMb.toFixed(1)} MB`);
});
