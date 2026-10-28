# pi-subagents-unbloated

Subagents for Pi. Nothing else.

A Pi extension that adds one tool, `subagent`, so the parent model can hand self-contained tasks to independent child agents and get compact results back. It is not a workflow engine, scheduler, or supervisor. The parent model plans; this package only runs things.

- One tool, no system prompt changes, no agent list in the tool description.
- Zero runtime dependencies (Pi supplies its own packages as peer dependencies).
- Nothing runs while idle: no child processes, no timers, no filesystem scans at registration.
- One Pi child process per agent, controlled over Pi's RPC mode.

## Install

Install as a Pi package (see Pi's `docs/packages.md`). From npm:

```bash
pi install npm:pi-subagents-unbloated
pi install npm:pi-subagents-unbloated@0.1.0   # pinned version
```

From git:

```bash
pi install git:github.com/<owner>/pi-subagents-unbloated
pi install git:github.com/<owner>/pi-subagents-unbloated@v0.1.0   # pinned tag
```

Replace `<owner>` with the repository owner (the package is not yet published, so the npm form works only after a release). Add `--local` (or `-l`) to write the declaration to the project's `.pi/settings.json` instead of your user settings. To try it for one run without installing: `pi -e ./path/to/pi-subagents-unbloated` or `pi -e git:github.com/<owner>/pi-subagents-unbloated`.

## The `subagent` tool

```ts
subagent({ action, agent?, task?, id?, message?, wait? })
```

| Action | Needs | What it does |
| --- | --- | --- |
| `agents` | none | List available agent definitions, plus discovery warnings. |
| `start` | `agent`, `task` | Launch a child. Returns a job id immediately; with `wait: true` blocks until the job finishes and returns its result. `task` must be self-contained: the child sees nothing of the parent conversation. |
| `list` | none | One line per job (including jobs interrupted by a restart). Does not consume results. |
| `status` | `id` | Live state of one job without loading a transcript. If the job has finished, asking for it returns its result and marks it delivered. |
| `steer` | `id`, `message` | Send a message to a running job. Rejected once the job has ended. |
| `cancel` | `id` | Cancel a job. Idempotent; the outcome is deterministic if it races completion. |
| `inbox` | none | Drain everything finished and not yet delivered, on demand. |

Invalid combinations (for example `start` without `task`) are rejected with a short error. A `/subagents` command shows the job list.

Concurrency is a fixed limit of 4 running jobs with one FIFO queue. Results are bounded in size and truncated with an explicit marker.

### How results reach the parent

Finished jobs go into one in-memory inbox per session. That inbox is the only path by which results reach the model.

- A result is delivered at most once, by whichever path gets there first.
- When the parent is idle and a job finishes, the parent is woken once, and the wakeup message drains everything that has finished by then, as one message.
- A result you read mid-turn (via `status`, `start` with `wait`, or `inbox`) is marked delivered and never wakes you again. If you read job B mid-turn, B causes no wakeup after the turn.
- A job that finishes while a turn is running wakes the parent after the turn only if its result was not consumed during the turn.

## Agent definitions

An agent is a Markdown file with frontmatter:

```markdown
---
name: reviewer
description: Reviews a diff for bugs and risky changes
tools: read, grep, find, ls
model: inherit
---
You are a careful code reviewer. Report concrete problems with file and line.
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Agent name used in `start`. |
| `description` | yes | Shown by `agents`. |
| `tools` | no | Comma-separated allowlist passed to the child. Omitted means Pi's default tools. |
| `model` | no | A Pi model id, or `inherit` (default) to use the parent's current model. |

The body is appended to the child's system prompt. There are no tier aliases, inheritance, or routing.

Where agents live:

- User agents: `<Pi agent dir>/agents/*.md` (normally `~/.pi/agent/agents/`). Loaded by default.
- Project agents: the nearest `.pi/agents/` walking up from the working directory. Loaded only when Pi's project trust is granted; never implicitly approved.

Precedence: a project agent overrides a user agent of the same name. Within one directory, duplicate names resolve to the first by sorted filename, with a warning. Files missing `name` or `description` are skipped with a warning. Discovery happens on demand, never at startup.

## Guarantees

- Each job has a unique id, at most one live child, and a single terminal transition (completed, failed, or cancelled).
- The concurrency slot is released exactly once, and at most one completion notification is produced per job.
- Provider errors, protocol errors, child exits, and timeouts are reported distinctly. A failed child is never turned into a successful empty result.
- Shutdown stops accepting jobs, cancels queued ones, asks running ones to stop, then force-terminates what remains.
- Children are spawned without a shell, with explicit working directory, and do not receive the `subagent` tool.
- Child output is parsed as LF-framed JSONL with bounded buffers; child UI dialogs are denied rather than forwarded.

## Limitations

- Tool allowlists are not a sandbox. Children share the filesystem, network, credentials, and environment of the parent user. There is no custom sandbox in this package.
- Background means non-blocking for the parent turn, not durable. Jobs do not survive Pi exiting. After a restart, jobs that were running are reported as `interrupted`; they are not resumed or restarted.
- Process isolation is not filesystem isolation. Read-only agents may run concurrently, but only one unisolated writer runs per working directory at a time (`bash` counts as writing); others queue.
- No automatic retries. A failed task is reported and left to the parent to decide, since retrying may repeat side effects.
- No recursive subagents: children cannot launch children.
- Not included by design: tmux, git worktree isolation, workflows, scheduling, memory, full-screen UI.
- Windows: the launch path (resolving Pi and spawning without a shell) is covered by CI on Windows for unit tests only, and has not been verified end to end on a real Windows machine with a live Pi. Set `PI_BIN` to your Pi executable if auto-resolution fails.
- Requires Pi 1.4.0 or compatible RPC behavior; the child flags were verified against 1.4.0.

## Size, dependencies, performance

- Source: 43,208 bytes across 7 files in `src/` (`wc -c src/*.ts`).
- Runtime dependencies: 0. `peerDependencies` are `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `typebox`, all supplied by Pi.

Measured on one machine (Linux under WSL2, Intel Core i5-14400F, Bun 1.3.13, Pi 1.4.0, local zero-delay fake model provider). Figures vary run to run; WSL2 noise is large. Full methodology and more tables are in [PERFORMANCE.md](PERFORMANCE.md).

| Metric | Measured |
| --- | --- |
| Cold added context | 587 B of tool JSON, 0 B system prompt (about 147 tokens, bytes/4 estimate) vs 1810 B for Pi's official example subagent extension |
| Startup overhead | Pi spawn to `get_state` with the extension: delta vs bare Pi p50 9.9 ms (an empty extension costs p50 8.8 ms, so about 1.2 ms is ours). Paired p95 16.0 ms, noise-limited |
| Extension factory | 0.1 ms |
| Child launch (start to ack) | p50 252.0 ms, p95 273.4 ms (direct RPC baseline: p50 236.3 ms, p95 345.7 ms) |
| End-to-end, 1 child | p50 285.0 ms, p95 305.1 ms |
| Concurrent children (start to ack p50 / RSS per child) | 1: 256.6 ms / 108.5 MB; 2: 256.0 ms / 110.3 MB; 4: 275.6 ms / 109.2 MB; 8: 423.1 ms / 110.7 MB |
| Cancel all (8 children) | p50 24.4 ms, p95 30.4 ms |

Reproduce:

```bash
bun bench/startup.ts 20
bun bench/delegation.ts 10
bun bench/context.ts
bun run bench          # all three
```

## Development

```bash
bun install
bun test                       # unit and fake-Pi end-to-end tests
PI_INTEGRATION=1 bun test      # also runs tests against a real Pi (needs `pi` on PATH, or PI_BIN)
bun run typecheck
bun run bench
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module layout and the RPC decision.

## License

MIT
