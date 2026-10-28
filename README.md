# pi-subagents-unbloated

Subagents for Pi. Nothing else.

A Pi extension that adds one tool, `subagent`, so the parent model can hand self-contained tasks to independent child agents and get compact results back. It is not a workflow engine, scheduler, or supervisor. The parent model plans; this package only runs things.

- One tool. The only prompt addition is a short agent list (name plus a 60-character blurb each, about 260 bytes for three agents), read once per session, so the model can `start` an agent without an `agents` call.
- Zero runtime dependencies (Pi supplies its own packages as peer dependencies).
- Nothing runs while idle: no child processes, no timers, no filesystem scans at registration.
- One Pi child process per agent by default, controlled over Pi's RPC mode. Agents that opt in with `inprocess: true` run inside the parent process through Pi's SDK instead.

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
subagent({ action, agent?, task?, id?, message?, wait?, isolate? })
```

| Action | Needs | What it does |
| --- | --- | --- |
| `agents` | none | List available agent definitions, plus discovery warnings. |
| `start` | `agent`, `task` | Launch a child. Returns a job id immediately; with `wait: true` blocks until the job finishes and returns its result. `task` must be self-contained: the child sees nothing of the parent conversation, though Pi still loads project `AGENTS.md`/`CLAUDE.md` files for its working directory. With `isolate: true` the child runs in its own git worktree (see below). |
| `list` | none | One line per job (including jobs interrupted by a restart). Does not consume results. |
| `status` | `id` | Live state of one job without loading a transcript. If the job has finished, asking for it returns its result and marks it delivered. |
| `steer` | `id`, `message` | Send a message to a running job. Rejected once the job has ended. |
| `cancel` | `id` | Cancel a job. Idempotent; the outcome is deterministic if it races completion. |
| `inbox` | none | Drain everything finished and not yet delivered, on demand. |
| `diff` | `id` | List the files an isolated job changed and show its diff (truncated at 6000 characters with a marker). Only after the job has ended. |
| `apply` | `id` | Apply an isolated job's changes to your working tree, then remove its worktree. Only after the job has ended. |
| `discard` | `id` | Throw away an isolated job's worktree and branch. Explicit, and only after the job has ended. |

Invalid combinations (for example `start` without `task`) are rejected with a short error. A `/subagents` command shows the job list, and `/subagent-model` opens a menu to pick an agent's model and thinking level (see Agent definitions).

Concurrency is limited per backend: 6 child processes and 50 in-process agents at once, with one strict FIFO queue per backend (a full backend never blocks the other). At most 128 jobs may be outstanding (running or queued); `start` beyond that is rejected. Results are bounded in size and truncated with an explicit marker.

### Status widget

In the terminal UI a widget above the editor shows running jobs and finished jobs you have not read yet:

```text
● Agents
├─ ⠹ researcher  Refactor auth module · ↻ 5 · 5 tool uses · 33.8k token (62%) · 12.3s
│      ⎿  editing 2 files…
├─ ⠹ scout  Find auth files · ↻ 3 · 3 tool uses · 12.4k token (8%) · 4.1s
│      ⎿  searching…
├─ ✓ writer  Draft the notes · ↻ 4 · 7 tool uses · 21.0k token · 18.0s
└─ 2 queued
```

- **Row:** spinner, agent, task, then turns (`↻ n`, counted as each turn starts), tool calls, tokens and elapsed time. All four always show, so a quiet agent reads as zeros. Finished rows show `✓` (done), `✗` (failed, with the error) or `■` (cancelled).
- **Live counts:** they move while a message streams in. A tool call counts as soon as it begins streaming, before it runs. Tokens are the context size at the last finished message plus an estimate of what has streamed since (about 4 characters per token); when the message ends, the provider's own figure replaces the estimate, so the number can step down slightly.
- **Context use:** the percentage is that token figure over the model's context window (dim, then yellow from 70%, red from 85%). It shows while the job runs, and only when the model is known.
- **Activity line:** the tools running right now (`reading`, `editing 2 files`, `searching the web`), otherwise the end of the text it is writing, otherwise `thinking…`.
- **Overflow:** at most 5 jobs are listed. The rest collapse into a final `+N more, M queued` row, or `M queued` alone.
- **Lifetime:** a finished job leaves the widget once its result has been delivered to the model. The widget clears when nothing is left and only animates while a job is running.
- **Keyboard:** press **Down** at an empty prompt to move a cursor (`▸`) onto the agents. Up and Down move it, **Enter** opens a menu for the selected agent, and **Esc** closes the list. A running agent offers *Steer* (type a message to redirect it), *Cancel* and *Model and thinking* (see below). A finished one offers *Show result* and *Model and thinking*. Esc is consumed while the list is open, so it never cancels Pi's current turn; with the list closed, Esc is Pi's again. The list does nothing while you are typing or while one of Pi's own dialogs has the keyboard.
- It costs no model context, is not persisted, and is skipped outside the terminal UI. Both the child-process and in-process backends feed it from the same events.

### Worktree isolation

`start` with `isolate: true` runs the child in a fresh git worktree instead of your working tree.

- The worktree is created from `HEAD` on a branch `pi-subagent/<id>`, and your uncommitted work (tracked changes and untracked files) is carried into it as a diff, so the child sees what you see. Ignored files are not carried. Submodules are unsupported (gitlinks and nested repos are skipped).
- `diff <id>` shows only what the agent changed, relative to a snapshot taken when the worktree was created.
- `apply <id>` is conflict-checked: if any file the agent touched has since changed in your tree, it fails and changes nothing, and the worktree is kept. On success it applies the changes and removes the worktree.
- `discard <id>` removes the worktree and branch. Nothing is discarded implicitly; an unreviewed worktree stays until you `apply` or `discard` it.
- Worktrees live under `<git-common-dir>/pi-subagents`, so they do not show up in `git status`, and they survive Pi restarts. The job itself does not survive (it is reported `interrupted`), but you can still `diff`, `apply` or `discard` its worktree.
- Isolation is opt-in. Without `isolate`, every agent works in your tree and runs in parallel with the others, whatever tools it has; if two edit the same file, the last write wins. Use `isolate: true` when parallel agents may touch the same files.

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
| `tools` | no | Comma-separated allowlist passed to the child. Omitted means the agent is not restricted: it gets the tools the parent has active when it starts (minus `subagent`). Only tools that exist in a subagent session are usable, which means Pi's built-ins (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) and not tools registered by extensions or MCP. Names that do not exist are dropped silently. |
| `model` | no | A Pi model id, or `inherit` (default) to use the parent's current model. |
| `thinking` | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Omitted means the parent's current level. |
| `inprocess` | no | `true` runs the agent in the parent process through Pi's SDK instead of a child Pi process (default `false`). See below. |

The body is appended to the child's system prompt.

`/subagent-model` edits `model` and `thinking` for you: choose an agent, then a model (or `inherit`), then a thinking level (or `inherit`). The model list is your scoped models (`enabledModels` or `--models`) when you have set any, otherwise every model with credentials. The choice is written into the agent's own file, which is the only thing it changes; the model is quoted so ids containing `:` survive.

### In-process agents

`inprocess: true` trades isolation for cost. Measured against the real SDK with a local fake model, 20 in-process agents grew the process by about 18 MB in total, where 20 child processes would be around 2 GB. Use it for trusted, mostly read-only agents that you fan out widely, such as web researchers.

It behaves the same from the model's side (same tool, results, steering, cancel, widget). What you give up:

- No crash isolation: an uncaught failure in one agent shares the parent's process.
- No hard kill: cancel and timeout call the SDK's abort, which stops the turn and the tool processes it started, but a tool that ignores the abort could outlive it.
- Credentials and environment are shared with the parent, and all in-process agents share one model and credential runtime.
- It is coupled to Pi's SDK, whose internals have changed between releases, so a Pi upgrade is more likely to affect it than the RPC protocol.

The agent's tool allowlist, system prompt, model, thinking level and project trust are applied the same way as for child processes. Extensions, skills, prompt templates and themes stay off, and project `AGENTS.md`/`CLAUDE.md` files still load. There are no tier aliases, inheritance, or routing.

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
- Background means non-blocking for the parent turn, not durable. Jobs do not survive Pi exiting. After a restart, jobs that were running are reported as `interrupted`; they are not resumed or restarted. Results that had finished but were never read are saved at shutdown and shown once, without waking the agent, at the next start.
- Process isolation is not filesystem isolation. Agents share your working tree and run concurrently up to the limit, with no locking; use `isolate: true` when parallel agents may edit the same files.
- No automatic retries. A failed task is reported and left to the parent to decide, since retrying may repeat side effects.
- No recursive subagents: children cannot launch children.
- Not included by design: tmux, workflows, scheduling, memory, full-screen UI.
- Windows: the launch path (resolving Pi and spawning without a shell) is covered by CI on Windows for unit tests only, and has not been verified end to end on a real Windows machine with a live Pi. Set `PI_BIN` to your Pi executable if auto-resolution fails. Descendant process-group cleanup is POSIX-only; on Windows termination targets the direct child.
- Requires Pi 1.4.0 or compatible RPC behavior; the child flags were verified against 1.4.0.

## Size, dependencies, performance

- Source: 76,382 bytes across 12 files in `src/` (`wc -c src/*.ts`).
- Runtime dependencies: 0. the one peer dependency is `@earendil-works/pi-coding-agent` (`>=1.4.0 <2`), supplied by Pi. `pi-ai` and `typebox` are development dependencies only.

Measured on one machine (Linux under WSL2, Intel Core i5-14400F, Bun 1.3.13, Pi 1.4.0, local zero-delay fake model provider). Figures vary run to run; WSL2 noise is large. Full methodology and more tables are in [PERFORMANCE.md](PERFORMANCE.md).

| Metric | Measured |
| --- | --- |
| Cold added context | 719 B tool schema entry, 0 B system prompt before the agent list is added (the list adds about 90 bytes per agent, measured: 263 B for three agents) (about 180 tokens, bytes/4 estimate; 720 B tools-only delta) vs 1810 B for Pi's official example subagent extension |
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
