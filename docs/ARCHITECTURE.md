# Architecture

## Principles

1. One execution architecture: one Pi child process per active agent, controlled over RPC. No parallel backends (in-process, tmux, daemon).
2. One model-facing tool, `subagent`.
3. No polling where events exist.
4. No implicit destructive cleanup.
5. Optimize measured bottlenecks only.

## Modules

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Pi integration: registers the tool and `/subagents`, dispatches actions, session lifecycle hooks, completion delivery. Loads everything else lazily on the first tool call. |
| `src/schema.ts` | The tool contract: plain JSON Schema, single-source action list and required arguments, shared result strings. |
| `src/recovery.ts` | Replays persisted session entries in one pass: job records, live worktrees, unread results. |
| `src/agents.ts` | On-demand agent discovery, frontmatter parsing via Pi's parser, trust and precedence rules. |
| `src/runner.ts` | Spawns a child Pi, sends the prompt, observes completion, steers, cancels, terminates. Small `Runner` interface so tests inject a fake. |
| `src/pi-command.ts` | Resolves the Pi command: `PI_BIN`, then this process's own Pi entry, then the installed package, then `pi` on PATH, with Windows shim handling. |
| `src/protocol.ts` | RPC adapter: LF-framed JSONL, command-id correlation, events, bounded buffers. |
| `src/jobs.ts` | Job table, queue (first eligible job in FIFO order; a writer blocked on its repository lock is skipped), outstanding-job cap, state machine, writer lock per canonical repository (canonical cwd outside Git), exactly-once slot release, restore of interrupted jobs. |
| `src/inbox.ts` | Per-session inbox of finished jobs: publish once, drain, take one, bounded formatting. |
| `src/types.ts` | Cross-module types only. |

Tests live in `test/` (unit, fake-Pi end to end, and gated real-Pi integration); benchmarks in `bench/`.

## Child process

Each child runs `pi --mode rpc` with extensions, skills, prompt templates, themes, and MCP disabled, `--offline`, `--no-session`, an explicit working directory and tool allowlist, the agent body appended to the system prompt, and `--approve` or `--no-approve` matching the parent's project trust. Parent history is never passed. The child is spawned without a shell and in its own process group on POSIX so the whole group can be signalled, including descendants left after its leader exits. Windows termination targets the direct child.

Job state is in memory. Only compact lifecycle metadata is persisted, as Pi session entries, so a restart can report jobs as `interrupted`. There is no job database.

## Decision: RPC child processes, not an in-process SDK

Phase 0 prototyped both and compared them (Linux/WSL2, Pi 1.4.0).

| | RPC child | In-process SDK |
| --- | --- | --- |
| Create | about 230 ms p50 (isolated flags) | about 0.5 ms |
| Memory | about 106 MB RSS per child | about 0.02 MB heap |
| Abort | stdin close exits in about 6 ms; SIGKILL about 4 ms; child dies with its pipe if the parent crashes | cooperative `abort()`, no hard kill |
| Crash blast radius | the child only | the whole parent Pi |
| Coupling | stable wire protocol | SDK internals, which changed between 1.1.0 and 1.4.0 |
| Shared state | separate env, auth, cwd | shared env and `auth.json` race |

The SDK wins on startup and memory, but about 230 ms is small next to model latency, while process isolation, hard kill, and a stable protocol directly serve reliability. RPC was chosen under the rule "RPC unless the SDK is materially better without reliability or coupling cost". An SDK fast path may be revisited only with real-model measurements and a separate proposal; the two backends are never maintained together.

Pi's exported `RpcClient` hardcodes `spawn("node", ...)` with no Windows `.cmd` handling, so `protocol.ts` is a small own adapter instead.

## RPC rules the code follows

- A `prompt` success response means accepted, not done; completion is `agent_settled`.
- Subscribe to events before prompting; track command ids.
- stdout is JSONL with LF framing only; stderr is diagnostics. Always drain stdout.
- Bound the incomplete-record buffer, retained stderr, result size, and pending requests.
- Every wait has a deadline: launch, task duration, shutdown grace.
- Child UI dialogs (select, confirm, input, editor) are denied, never forwarded.
- No automatic retry.
