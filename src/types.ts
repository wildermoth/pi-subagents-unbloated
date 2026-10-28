/** Shared contracts between agents, runner, jobs and the Pi integration. */

export interface AgentDef {
  name: string;
  description: string;
  /** Explicit tool allowlist; undefined means the child's default tools. */
  tools?: string[];
  /** Pi model id, or undefined to inherit the parent's model. */
  model?: string;
  /** Markdown body, appended to the child's system prompt. */
  prompt: string;
  source: "user" | "project";
  path: string;
}

export interface RunSpec {
  cwd: string;
  task: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  /** Mirrors the parent's project trust decision (--approve / --no-approve). */
  trusted: boolean;
  /** Max time from launch to settled. */
  timeoutMs: number;
  /** Max time from launch to prompt acknowledgement. */
  launchTimeoutMs: number;
}

export type RunStatus = "completed" | "failed" | "cancelled";

export type FailureKind = "launch" | "protocol" | "exit" | "timeout" | "provider" | "rejected";

export type RunResult = {
  /** Final assistant text, bounded by the runner's maxResultBytes. */
  text: string;
  truncated: boolean;
} & ({ status: "failed"; failure: { kind: FailureKind; message: string } } | { status: "completed" | "cancelled"; failure?: never });

/** A live child. Exactly one of done's outcomes occurs; cancel/steer are idempotent and safe after done. */
export interface Child {
  readonly done: Promise<RunResult>;
  steer(message: string): Promise<void>;
  cancel(): Promise<void>;
}

/** Injectable so jobs and tools can be tested without spawning Pi. */
export interface Runner {
  start(spec: RunSpec): Child;
}
