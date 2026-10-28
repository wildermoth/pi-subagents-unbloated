# PERFORMANCE

Targets come from the performance note (`knowledge/20261029_performance-and-context-budgets.md`). All numbers below were measured in one run on the machine below. Nothing is estimated unless marked.

## Environment

| Item | Value |
| --- | --- |
| Date | 2026-10-29 |
| OS | Linux 6.18.54.1-microsoft-standard-WSL2 (WSL2) |
| CPU | Intel Core i5-14400F, 8 logical CPUs listed by nproc, 24 GB RAM |
| Bun | 1.3.13 |
| Pi | 1.4.0 |
| Model | local zero-delay fake OpenAI-compatible provider (no cost) |

Pi runs with an isolated `PI_CODING_AGENT_DIR` (temp dir, only a fake `models.json`), `PI_TELEMETRY=0`, `--no-skills --no-prompt-templates --no-themes --no-mcp --no-context-files --offline --no-session`.

## Commands

```
bun bench/startup.ts 20       # extension import/factory cost, Pi startup with vs without extension, idle
bun bench/delegation.ts 10    # launch latency, end-to-end, concurrency 1/2/4/8, RSS, cancel-all
bun bench/context.ts          # cold context bytes of the first parent request
bun run bench                 # all three (default run counts: startup 20, delegation 10)
```

Helpers live in `bench/lib.ts`. Percentiles are nearest-rank over the samples.

## Results vs targets

| Metric | Target | Measured | Status |
| --- | --- | --- | --- |
| Runtime npm deps | 0 | 0 (`dependencies` absent; only peer/dev deps) | met |
| Idle children / timers / registration fs scans | 0 | 0 child processes, 0 timers (setTimeout/setInterval/setImmediate tracked during factory with a stub pi), 0 handle delta, 0 Pi descendants at idle with extension. fs scans: factory is synchronous and imports no fs; not instrumented beyond that | met |
| Extra model-facing tools | 1 | 1 (`subagent`) | met |
| Source size | < 100 KB excl. tests | 42,253 bytes (`cat src/*.ts`, about 41.3 KiB) | met |
| Cold added context | < 250 tokens incl. schema | 587 B of tools JSON, 0 B system prompt = about 147 tokens (bytes/4 ESTIMATE, not a tokenizer count) | met (estimate) |
| Startup overhead | < 10 ms p95 | Pi spawn to get_state, 20 interleaved runs after lazy loading and plain JSON Schema: delta vs bare p50 9.9 ms, p95 9.5 ms (paired p50 9.0, p95 16.0). An empty extension costs p50 8.8 ms, so Pi's own loading accounts for most of it; ours beyond that floor is p50 1.2 ms. Factory 0.1 ms. Before the change the delta was p50 10.7 to 12.5 ms, p95 26.6 to 45.2 ms | Met at p50/unpaired p95; paired p95 16 ms is noise-limited (see notes) |
| Child startup | report p50/p95 vs Pi baseline | start to ack p50 252.0 / p95 273.4 ms vs direct RPC baseline spawn to get_state p50 236.3 / p95 345.7 ms | reported |
| Duplicate notifications / silent output loss | 0 in tests | not a benchmark; covered by `bun test` | n/a |

Notes on startup: the first measurement missed the target (p50 12.5 ms). Two changes were made: jobs, inbox and runner now load lazily on the first tool call, and the tool schema is a plain JSON Schema object so typebox and pi-ai are not imported at startup. A new `-e empty extension` variant in `bench/startup.ts` shows that Pi itself charges about 9 ms for loading any extension, so the overhead attributable to this package is about 1 ms at p50. Run-to-run noise on WSL2 is large (paired diffs range several ms either way), so treat p95 figures as indicative.

## 1. Extension startup (`bench/startup.ts`, 20 runs)

| Measurement | p50 | p95 | min | max |
| --- | --- | --- | --- | --- |
| `import("src/index.ts")`, fresh Bun process | 85.7 ms | 97.9 ms | 78.5 | 99.0 |
| `factory(stubPi)` | 0.1 ms | 0.2 ms | 0.1 | 0.2 |
| Pi `--mode rpc` spawn to get_state, `--no-extensions` (bare Pi) | 225.4 ms | 254.4 ms | 216.9 | 274.3 |
| Pi spawn to get_state, `--no-extensions -e src/index.ts` | 242.3 ms | 282.1 ms | 231.1 | 372.5 |
| Paired diff (ext minus bare, interleaved runs) | 12.5 ms | 45.2 ms | -28.2 | 137.6 |

Factory registers: `registerTool`, `registerCommand`, and three `on` handlers. The extension was confirmed loaded in the `-e` variant (the `subagents` command appears in `get_commands`). One unrecorded warm-up spawn per variant precedes the timed runs.

## 2. Delegation (`bench/delegation.ts`, 10 rounds per level)

Launch latency is measured with `RpcConnection` plus the runner's own `buildArgs` and `resolvePiCommand` (the Runner interface does not expose ack/first-event timing). End-to-end and cancel-all use `createRunner` directly. "First event" is the first JSONL record that is not a command response. In practice it arrives within 0.3 ms of the ack, so ack and first event are effectively the same instant here.

Baseline, direct minimal RPC (spawn to get_state, 10 runs): p50 236.3 ms, p95 345.7 ms.
Sequential single child launch: start to ack p50 252.0 ms / p95 273.4 ms; start to first event p50 252.2 / p95 273.5 ms.

| Concurrent children | start to ack p50 / p95 (ms) | start to first event p50 / p95 (ms) | end-to-end per child p50 / p95 (ms) | peak RSS sum, max (MB) | RSS per child (MB) |
| --- | --- | --- | --- | --- | --- |
| 1 | 256.6 / 270.8 | 256.8 / 271.1 | 285.0 / 305.1 | 108.5 | 108.5 |
| 2 | 256.0 / 307.3 | 256.2 / 307.9 | 300.9 / 315.8 | 220.6 | 110.3 |
| 4 | 275.6 / 308.3 | 275.6 / 308.9 | 317.6 / 366.4 | 436.7 | 109.2 |
| 8 | 423.1 / 474.5 | 423.1 / 474.7 | 482.6 / 571.8 | 885.3 | 110.7 |

End-to-end is measured from the first `runner.start` of the batch until each child's `done` resolves, with a zero-delay fake model that answers "fake answer". Peak RSS is the sum of VmRSS over all descendants of the bench process, sampled every 25 ms during the concurrent launch phase (children are stopped right after the ack, so this is the idle-ready footprint rather than a full run).

Shutdown, cancel all children blocked on a hanging model request (5 rounds each, every child reported `cancelled`, no leaked processes):

| Children | cancel-all p50 | p95 |
| --- | --- | --- |
| 1 | 12.9 ms | 15.9 ms |
| 2 | 14.6 ms | 16.4 ms |
| 4 | 19.7 ms | 25.0 ms |
| 8 | 24.4 ms | 30.4 ms |

Cancel-all success rate: 100 percent (20 of 20 rounds, all children cancelled, zero leaked descendants).

## 3. Cold context (`bench/context.ts`)

First request body a real parent Pi (`--mode rpc`, default builtin tools, fake model) sends to the fake provider. Token figures are an ESTIMATE of bytes/4, not tokenizer counts.

| Variant | tools array (B) | system prompt (B) | whole body (B) | Added vs bare (tools + system) |
| --- | --- | --- | --- | --- |
| Bare Pi (read, bash, edit, write) | 2841 | 2837 | 5904 | baseline |
| This extension (+ `subagent`) | 3428 | 2837 | 6491 | +587 B tools, +0 B system = 587 B, about 147 tokens (estimate) |
| Pi official example subagent extension (`-e` standalone, loads fine, adds `subagent`) | 4651 | 2837 | 7714 | +1810 B tools, +0 B system = 1810 B, about 453 tokens (estimate) |

This extension adds 3.1 times fewer bytes than the official example. Neither extension modifies the system prompt. Added tool JSON is a single `subagent` function with an action enum and five optional string/boolean fields.

## Baselines summary

- Bare Pi spawn to get_state: p50 225.4 / p95 254.4 ms (startup.ts); 236.3 / 345.7 ms in the delegation run (different isolation flags, `--tools read,grep,find,ls`, separate session of runs, so the two baselines carry run-to-run noise of about 10 ms at p50).
- Bare Pi first-request context: 5904 B body.
