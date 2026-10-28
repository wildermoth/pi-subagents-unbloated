import { describe, expect, test } from "bun:test";
import { splitModel } from "../src/agents.ts";
import { createSdkRunner } from "../src/sdk-runner.ts";
import type { Progress } from "../src/types.ts";
import type { RunSpec } from "../src/types.ts";

const spec = (o: Partial<RunSpec> = {}): RunSpec => ({
  cwd: "/work",
  task: "do it",
  systemPrompt: "Be brief.",
  trusted: true,
  timeoutMs: 5000,
  launchTimeoutMs: 1000,
  inprocess: true,
  ...o,
});

const assistant = (text: string, stopReason = "stop", extra: object = {}) => ({
  role: "assistant",
  stopReason,
  content: [{ type: "text", text }],
  ...extra,
});

class FakeSession {
  constructor(private readonly script: (s: FakeSession) => Promise<void> | void) {}
  messages: unknown[] = [];
  listeners: ((e: any) => void)[] = [];
  aborts = 0;
  disposed = 0;
  steered: string[] = [];
  hangs = false;
  release!: () => void;
  subscribe(l: (e: any) => void) {
    this.listeners.push(l);
    return () => {};
  }
  say(m: object) {
    this.messages.push(m);
    this.emit({ type: "message_end", message: m });
  }
  emit(e: object) {
    for (const l of this.listeners) l(e);
  }
  async prompt() {
    await this.script(this);
    if (this.hangs) await new Promise<void>((r) => (this.release = r));
  }
  async steer(m: string) {
    this.steered.push(m);
    return "queued";
  }
  async abort() {
    this.aborts++;
    this.release?.();
  }
  dispose() {
    this.disposed++;
  }
}

/** A scripted stand-in for Pi's SDK; `script` decides what a prompt does. */
function fakeSdk(script: (s: FakeSession) => Promise<void> | void = (s) => s.say(assistant("done")), opts: { models?: string[] } = {}) {
  const calls = { loader: undefined as any, settings: undefined as any, session: undefined as any, sessions: [] as FakeSession[] };
  const known = new Set(opts.models ?? ["prov/model"]);
  const sdk = {
    ModelRuntime: { create: async () => ({ getModel: (p: string, id: string) => (known.has(`${p}/${id}`) ? { p, id } : undefined) }) },
    SettingsManager: { inMemory: (s: unknown, o: unknown) => (calls.settings = { s, o }) },
    getAgentDir: () => "/agent",
    DefaultResourceLoader: class {
      constructor(o: unknown) {
        calls.loader = o;
      }
      async reload() {}
    },
    SessionManager: { inMemory: (cwd: string) => ({ cwd }) },
    createAgentSession: async (o: unknown) => {
      calls.session = o;
      const session = new FakeSession(script);
      calls.sessions.push(session);
      return { session };
    },
  };
  return { load: async () => sdk as never, calls, FakeSession };
}

describe("splitModel", () => {
  test("provider is the first segment, the id keeps its slashes", () => {
    expect(splitModel("openrouter/meta/muse")).toEqual({ provider: "openrouter", id: "meta/muse" });
    expect(splitModel("prov/model")).toEqual({ provider: "prov", id: "model" });
    expect(splitModel("nomodel")).toBeUndefined();
    expect(splitModel("/x")).toBeUndefined();
    expect(splitModel("x/")).toBeUndefined();
  });
});

describe("sdk runner", () => {
  test("completes with the last assistant text, reports progress, and releases the session", async () => {
    const f = fakeSdk((s) => {
      s.say(assistant("working", "stop", { usage: { totalTokens: 500 } }));
      s.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" });
      s.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read" });
      s.say(assistant("the answer", "stop", { usage: { totalTokens: 900 } }));
    });
    const seen: Progress[] = [];
    const r = await createSdkRunner({ load: f.load }).start(spec({ onProgress: (p) => seen.push(p) })).done;
    expect(r).toEqual({ status: "completed", text: "the answer", truncated: false });
    expect(seen.at(-1)).toEqual({ turns: 2, tools: 1, tokens: 900, active: [], text: "the answer" });
    expect(seen.some((p) => p.active.includes("read"))).toBe(true);
    expect(f.calls.sessions[0]!.disposed).toBe(1);
  });

  test("mirrors the child flags: tools, prompt, trust, no extensions or skills, context files kept", async () => {
    const f = fakeSdk();
    await createSdkRunner({ load: f.load }).start(spec({ tools: ["read", "grep"], trusted: false, thinking: "low", model: "prov/model" }))
      .done;
    expect(f.calls.loader).toMatchObject({
      cwd: "/work",
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: ["Be brief."],
    });
    expect(f.calls.loader.noContextFiles).toBeUndefined();
    expect(f.calls.settings.o).toEqual({ projectTrusted: false });
    expect(f.calls.session).toMatchObject({
      cwd: "/work",
      tools: ["read", "grep"],
      thinkingLevel: "low",
      model: { p: "prov", id: "model" },
    });
  });

  test("omits tools and model when the spec leaves them open", async () => {
    const f = fakeSdk();
    await createSdkRunner({ load: f.load }).start(spec()).done;
    expect("tools" in f.calls.session).toBe(false);
    expect("model" in f.calls.session).toBe(false);
  });

  test("an unknown model fails as a launch error without creating a session", async () => {
    const f = fakeSdk();
    const r = await createSdkRunner({ load: f.load }).start(spec({ model: "nope/model" })).done;
    expect(r).toMatchObject({ status: "failed", failure: { kind: "launch", message: expect.stringContaining("nope/model") } });
    expect(f.calls.sessions).toHaveLength(0);
  });

  test("provider errors and cut-off output fail, keeping the partial text", async () => {
    for (const [stop, msg] of [
      ["error", "boom"],
      ["length", "output length"],
    ] as const) {
      const f = fakeSdk((s) => s.say(assistant("partial", stop, { errorMessage: "boom" })));
      const r = await createSdkRunner({ load: f.load }).start(spec()).done;
      expect(r).toMatchObject({ status: "failed", text: "partial", failure: { kind: "provider", message: expect.stringContaining(msg) } });
    }
  });

  test("a rejected prompt is a provider failure and still releases the session", async () => {
    const f = fakeSdk(() => {
      throw new Error("no api key");
    });
    const r = await createSdkRunner({ load: f.load }).start(spec()).done;
    expect(r).toMatchObject({ status: "failed", failure: { kind: "provider", message: "no api key" } });
    expect(f.calls.sessions[0]!.disposed).toBe(1);
  });

  test("timeout aborts the session and fails with kind timeout", async () => {
    const f = fakeSdk((s) => void (s.hangs = true));
    const r = await createSdkRunner({ load: f.load }).start(spec({ timeoutMs: 30 })).done;
    expect(r).toMatchObject({ status: "failed", failure: { kind: "timeout" } });
    expect(f.calls.sessions[0]).toMatchObject({ aborts: 1, disposed: 1 });
  });

  test("cancel mid-run aborts once, disposes once, and is idempotent", async () => {
    const f = fakeSdk((s) => {
      s.say(assistant("so far"));
      s.hangs = true;
    });
    const child = createSdkRunner({ load: f.load }).start(spec());
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all([child.cancel(), child.cancel()]);
    expect(await child.done).toEqual({ status: "cancelled", text: "so far", truncated: false });
    expect(f.calls.sessions[0]).toMatchObject({ aborts: 1, disposed: 1 });
  });

  test("cancel before the session exists never leaks one", async () => {
    const f = fakeSdk();
    const child = createSdkRunner({ load: f.load }).start(spec());
    await child.cancel(); // synchronously after start: setup has not finished
    await new Promise((r) => setTimeout(r, 20));
    expect((await child.done).status).toBe("cancelled");
    for (const s of f.calls.sessions) expect(s.disposed).toBe(1);
  });

  test("steer reaches the session while running and is refused once finished", async () => {
    const f = fakeSdk((s) => void (s.hangs = true));
    const child = createSdkRunner({ load: f.load }).start(spec());
    await new Promise((r) => setTimeout(r, 20));
    await child.steer("go left");
    expect(f.calls.sessions[0]!.steered).toEqual(["go left"]);
    await child.cancel();
    await expect(child.steer("late")).rejects.toThrow("finished");
  });

  test("a throwing progress observer cannot fail the run", async () => {
    const f = fakeSdk();
    const r = await createSdkRunner({ load: f.load }).start(
      spec({
        onProgress: () => {
          throw new Error("display bug");
        },
      }),
    ).done;
    expect(r.status).toBe("completed");
  });

  test("result text is bounded", async () => {
    const f = fakeSdk((s) => s.say(assistant("x".repeat(500))));
    const r = await createSdkRunner({ load: f.load, maxResultBytes: 100 }).start(spec()).done;
    expect(r).toMatchObject({ status: "completed", truncated: true });
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(100);
  });
});
