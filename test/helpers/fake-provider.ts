// Shared fake OpenAI-compatible provider for real-Pi integration tests.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const chunk = (delta: object, finish: string | null = null, extra: object = {}) =>
  `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  })}\n\n`;
export const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
export const sse = (parts: string[]) =>
  new Response(parts.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
export const textReply = (t: string) =>
  sse([chunk({ role: "assistant", content: "" }), chunk({ content: t }), chunk({}, "stop", { usage })]);
/** One assistant turn issuing the given tool calls. */
export const toolCallsReply = (calls: { name: string; args: object }[]) =>
  sse([
    chunk({ role: "assistant", content: "" }),
    ...calls.map((c, i) =>
      chunk({
        tool_calls: [{ index: i, id: `call_${i + 1}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }],
      }),
    ),
    chunk({}, "tool_calls", { usage }),
  ]);

/** Serve /chat/completions; every request body is pushed to `bodies` before `handle` runs. */
export function startFakeServer(handle: (body: any) => Response | Promise<Response>, bodies: any[]) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      if (!req.url.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      const body = await req.json();
      bodies.push(body);
      return handle(body);
    },
  });
}

/** Fresh isolated agent dir whose models.json points at the fake server. */
export function makeAgentDir(port: number): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-int-agent-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
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
  mkdirSync(join(dir, "agents"));
  return dir;
}
