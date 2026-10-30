/** Runs a RunSpec as an in-process Pi SDK session. Same contract as runner.ts, cheaper, but no process isolation. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { splitModel, THINKING_LEVELS } from "./agents.ts";
import { asRecord, partialOf, settledOutcome } from "./outcome.ts";
import { createTracker } from "./progress.ts";
import type { JsonRecord } from "./protocol.ts";
import type { Child, FailureKind, RunResult, RunSpec, Runner } from "./types.ts";

type Sdk = typeof import("@earendil-works/pi-coding-agent");

export interface SdkRunnerOptions {
  /** Injectable so tests can run without Pi's real SDK. */
  load?: () => Promise<Sdk>;
  /** Max UTF-8 bytes of result text, marker included. Default 8192. */
  maxResultBytes?: number;
}

/** Builds the session a spec asks for. Mirrors buildArgs: everything off except Pi's own tools and project context files. */
async function openSession(
  sdk: Sdk,
  rt: ReturnType<Sdk["ModelRuntime"]["create"]> extends Promise<infer R> ? R : never,
  spec: RunSpec,
  stillWanted: () => boolean,
) {
  let model;
  if (spec.model) {
    const ref = splitModel(spec.model);
    model = ref && rt.getModel(ref.provider, ref.id);
    if (!model) throw new Error(`unknown model "${spec.model}"`);
  }
  const thinking = THINKING_LEVELS.find((level) => level === spec.thinking);
  if (spec.thinking && !thinking) throw new Error(`unknown thinking level "${spec.thinking}"`);
  const settingsManager = sdk.SettingsManager.inMemory({}, { projectTrusted: spec.trusted });
  const agentDir = sdk.getAgentDir();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: spec.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: spec.systemPrompt ? [spec.systemPrompt] : [],
  });
  await resourceLoader.reload();
  if (!stillWanted()) return undefined; // cancelled while loading
  const { session } = await sdk.createAgentSession({
    cwd: spec.cwd,
    agentDir,
    modelRuntime: rt,
    ...(model ? { model } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {}),
    ...(spec.tools ? { tools: spec.tools } : {}),
    resourceLoader,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(spec.cwd),
  });
  return session;
}

export function createSdkRunner(opts: SdkRunnerOptions = {}): Runner {
  const load = opts.load ?? (() => import("@earendil-works/pi-coding-agent"));
  const maxResultBytes = opts.maxResultBytes ?? 8192;
  // One model/credential runtime for every in-process agent: sessions share auth instead of racing on it.
  let runtime: ReturnType<Sdk["ModelRuntime"]["create"]> | undefined;
  const modelRuntime = (sdk: Sdk) =>
    (runtime ??= sdk.ModelRuntime.create().catch((err) => {
      runtime = undefined;
      throw err;
    }));

  return {
    start(spec: RunSpec): Child {
      let resolveDone!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => (resolveDone = r));
      let outcome: RunResult | undefined;
      let session: AgentSession | undefined;
      let lastAssistant: JsonRecord | undefined;

      /** Single terminal transition; the first caller wins. Always releases the session. */
      const decide = (r: RunResult): void => {
        if (outcome) return;
        outcome = r;
        clearTimeout(timer);
        clearTimeout(launchTimer);
        const s = session;
        void (async () => {
          try {
            await s?.abort(); // stops a running turn and any tool processes it started
          } catch {
            // already idle or disposed
          } finally {
            try {
              s?.dispose();
            } catch {
              // nothing left to release
            }
            resolveDone(r);
          }
        })();
      };
      const fail = (kind: FailureKind, message: string): void =>
        decide({ status: "failed", ...partialOf(lastAssistant, maxResultBytes), failure: { kind, message } });

      const track = createTracker(spec.onProgress);
      const onEvent = (ev: { type: string; message?: unknown }): void => {
        track(ev);
        const m = ev.type === "message_end" ? asRecord(ev.message) : undefined;
        if (m?.role === "assistant") lastAssistant = m;
      };

      const timer = setTimeout(() => fail("timeout", `run did not settle within ${spec.timeoutMs}ms`), spec.timeoutMs);
      const launchTimer = setTimeout(() => fail("timeout", `session did not start within ${spec.launchTimeoutMs}ms`), spec.launchTimeoutMs);
      void (async () => {
        try {
          const sdk = await load();
          if (outcome) return;
          const rt = await modelRuntime(sdk);
          if (outcome) return;
          session = await openSession(sdk, rt, spec, () => !outcome);
          if (!session) return;
          if (outcome) return void session.dispose();
          clearTimeout(launchTimer);
          session.subscribe(onEvent);
          await session.prompt(spec.task);
          if (outcome) return;
          lastAssistant ??= asRecord(session.messages.findLast((m) => (m as { role?: string }).role === "assistant"));
          decide(settledOutcome(lastAssistant, maxResultBytes));
        } catch (e) {
          if (!outcome) fail(session ? "provider" : "launch", e instanceof Error ? e.message : String(e));
        }
      })();

      return {
        done,
        async steer(message: string): Promise<void> {
          if (outcome || !session) throw new Error("run is finished");
          await session.steer(message);
        },
        async cancel(): Promise<void> {
          decide({ status: "cancelled", ...partialOf(lastAssistant, maxResultBytes) });
          await done;
        },
      };
    },
  };
}
