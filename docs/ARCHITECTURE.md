# Architecture

## Principles

1. Two execution backends behind one `Runner` interface: a Pi child process per agent over RPC (the default), and an opt-in in-process Pi SDK session (`inprocess: true` in the agent file). No tmux or daemon backend.
2. One model-facing tool, `subagent`.
3. No polling where events exist.
4. No implicit destructive cleanup.
5. Optimize measured bottlenecks only.

## Modules

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Pi integration: registers the tool and `/subagents`, dispatches actions, session lifecycle hooks, completion delivery. Loads everything else lazily on the first tool call. |
| `src/agents.ts` (prompt list) | At the first run of a session, `before_agent_start` adds a `subagents` section with each agent's name and 60-character blurb, cached for the session. |
| `src/schema.ts` | The tool contract: plain JSON Schema, single-source action list and required arguments, shared result strings. |
| `src/statusbar.ts` | Pure renderer for the live job widget: live plus unread jobs, capped at 5 lines with a hidden-count line. |
| `src/recovery.ts` | Replays persisted session entries in one pass: job records, live worktrees, unread results. |
| `src/agents.ts` | On-demand agent discovery, frontmatter parsing via Pi's parser, trust and precedence rules. |
| `src/runner.ts` | Spawns a child Pi, sends the prompt, observes completion, steers, cancels, terminates. Small `Runner` interface so tests inject a fake. |
| `src/pi-command.ts` | Resolves the Pi command: `PI_BIN`, then this process's own Pi entry, then the installed package, then `pi` on PATH, with Windows shim handling. |
| `src/sdk-runner.ts` | Opt-in backend: runs a RunSpec as an in-process SDK session behind the same `Runner` contract. One shared model and credential runtime, abort plus dispose for cancel and timeout. |
| `src/outcome.ts` | Result shaping both backends share: UTF-8 safe truncation and the mapping from a last assistant message to a RunResult. |
| `src/protocol.ts` | RPC adapter: LF-framed JSONL, command-id correlation, events, bounded buffers. |
| `src/jobs.ts` | Job table, FIFO queue per backend (6 child processes, 50 in-process), outstanding-job cap (128), state machine (no write locking: git isolation is opt-in), exactly-once slot release, restore of interrupted jobs. |
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

The SDK wins on startup and memory, but about 230 ms is small next to model latency, while process isolation, hard kill, and a stable protocol directly serve reliability. RPC was chosen under the rule "RPC unless the SDK is materially better without reliability or coupling cost". **Amended:** the human later asked for an opt-in SDK backend for trusted, widely fanned-out agents (`inprocess: true`). The `Runner` seam made that cheap, so the two backends now coexist; the RPC child stays the default and the safe choice. The SDK path was checked against the real SDK with a fake provider (cold import about 680 ms once, session creation under 1 ms, about 0.02 MB per session, abort stops a stuck tool and its processes, per-session working directory honored) but not yet with a paid real model.

Pi's exported `RpcClient` hardcodes `spawn("node", ...)` with no Windows `.cmd` handling, so `protocol.ts` is a small own adapter instead.

## RPC rules the code follows

- A `prompt` success response means accepted, not done; completion is `agent_settled`.
- Subscribe to events before prompting; track command ids.
- stdout is JSONL with LF framing only; stderr is diagnostics. Always drain stdout.
- Bound the incomplete-record buffer, retained stderr, result size, and pending requests.
- Every wait has a deadline: launch, task duration, shutdown grace.
- Child UI dialogs (select, confirm, input, editor) are denied, never forwarded.
- No automatic retry.
