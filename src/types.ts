/** Shared contracts between agents, runner, jobs and the Pi integration. */

export interface AgentDef {
  name: string;
  description: string;
  /** Explicit tool allowlist; undefined means the child's default tools. */
  tools?: string[];
  /** Pi model id, or undefined to inherit the parent's model. */
  model?: string;
  /** Thinking level, or undefined to inherit the parent's. */
  thinking?: string;
  /** Markdown body, appended to the child's system prompt. */
  prompt: string;
  /** Run in the parent process through Pi's SDK instead of a child Pi process. Cheaper, but no hard kill or crash isolation. */
  inprocess?: boolean;
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
  /** Run in-process through Pi's SDK instead of as a child Pi process. Chooses the backend and the concurrency lane. */
  inprocess?: boolean;
  /** Display only: called whenever progress changes. Failures in it never reach the run. */
  onProgress?: (p: Progress) => void;
}

/** A running agent at a glance, for the status widget. */
export interface Progress {
  /** Assistant messages finished so far. */
  turns: number;
  /** Tool calls started so far. */
  tools: number;
  /** Context size after the latest assistant message. */
  tokens: number;
  /** Names of tools running right now. */
  active: string[];
  /** Text of the latest assistant message. */
  text: string;
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
