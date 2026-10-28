/** Runs a RunSpec as an in-process Pi SDK session. Same contract as runner.ts, cheaper, but no process isolation. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { asRecord, assistantText, partialOf, settledOutcome } from "./outcome.ts";
import type { JsonRecord } from "./protocol.ts";
import type { Child, FailureKind, RunResult, RunSpec, Runner } from "./types.ts";

type Sdk = typeof import("@earendil-works/pi-coding-agent");

export interface SdkRunnerOptions {
  /** Injectable so tests can run without Pi's real SDK. */
  load?: () => Promise<Sdk>;
  /** Max UTF-8 bytes of result text, marker included. Default 8192. */
  maxResultBytes?: number;
}

/** "provider/model-id" where the id may itself contain slashes. */
export function splitModel(ref: string): { provider: string; id: string } | undefined {
  const i = ref.indexOf("/");
  return i > 0 && i < ref.length - 1 ? { provider: ref.slice(0, i), id: ref.slice(i + 1) } : undefined;
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
    ...(spec.thinking ? { thinkingLevel: spec.thinking as never } : {}),
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
  const modelRuntime = (sdk: Sdk) => (runtime ??= sdk.ModelRuntime.create());

  return {
    start(spec: RunSpec): Child {
      let resolveDone!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => (resolveDone = r));
      let outcome: RunResult | undefined;
      let session: AgentSession | undefined;
      let lastAssistant: JsonRecord | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      /** Single terminal transition; the first caller wins. Always releases the session. */
      const decide = (r: RunResult): void => {
        if (outcome) return;
        outcome = r;
        clearTimeout(timer);
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

      const onEvent = (ev: { type: string; message?: unknown }): void => {
        if (ev.type !== "message_end") return;
        const m = asRecord(ev.message);
        if (m?.role !== "assistant") return;
        lastAssistant = m;
        try {
          spec.onActivity?.(assistantText(m));
        } catch {
          // display only
        }
      };

      void (async () => {
        try {
          const sdk = await load();
          session = await openSession(sdk, await modelRuntime(sdk), spec, () => !outcome);
          if (!session) return;
          if (outcome) return void session.dispose();
          session.subscribe(onEvent);
          timer = setTimeout(() => fail("timeout", `run did not settle within ${spec.timeoutMs}ms`), spec.timeoutMs);
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
