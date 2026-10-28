// Real parent Pi + this extension + real children, against a scripted fake provider.
// Run with PI_INTEGRATION=1 bun test test/e2e.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { makeAgentDir, startFakeServer, textReply, toolCallsReply } from "./helpers/fake-provider.ts";
import { RpcConnection } from "../src/protocol.ts";
import { resolvePiCommand } from "../src/runner.ts";

const enabled = process.env.PI_INTEGRATION === "1";
const T = (name: string, fn: () => Promise<void>) => test.skipIf(!enabled)(name, fn, 90_000);

const bodies: any[] = [];
const childDone = new Map<string, true>(); // child task key -> reply sent
let childDelay: Record<string, number> = {};
let childScript: ((body: any) => Response | Promise<Response>) | undefined;
let parentScript: (body: any, parentIdx: number) => Response | Promise<Response> = () => textReply("idle");
let server: ReturnType<typeof Bun.serve>;
let agentDir: string;
let project: string;

const hasSubagent = (b: any) => (b.tools ?? []).some((t: any) => t.function?.name === "subagent");
const blob = (b: any) => JSON.stringify(b.messages);
const parentReqs = () => bodies.filter(hasSubagent);
const childReqs = () => bodies.filter((b) => !hasSubagent(b));
const hasToolResult = (b: any) => b.messages.some((m: any) => m.role === "tool");
const isWake = (b: any) => b.messages.some((m: any) => m.role === "user" && /subagent jobs? finished/.test(JSON.stringify(m.content)));
const start = (key: string, wait = false) => ({ name: "subagent", args: { action: "start", agent: "scout", task: `task-${key}`, wait } });
const until = async (cond: () => boolean, ms = 30_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await Bun.sleep(50);
  }
};
const toolTexts = (b: any) => b.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content));

async function handle(body: any): Promise<Response> {
  if (hasSubagent(body)) return parentScript(body, parentReqs().length - 1);
  if (childScript) return childScript(body);
  const key = /task-([A-Z]+)/.exec(blob(body))?.[1] ?? "?";
  await Bun.sleep(childDelay[key] ?? 300);
  childDone.set(key, true);
  return textReply(`result-${key}`);
}

beforeAll(() => {
  if (!enabled) return;
  server = startFakeServer(handle, bodies);
  agentDir = makeAgentDir(server.port!);
  project = mkdtempSync(join(tmpdir(), "pi-e2e-proj-"));
  writeFileSync(join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: Explore\ntools: read,grep\n---\nSCOUT-MARKER be brief.");
});
afterAll(() => { void server?.stop(true); }); // not awaited: pending hung-child replies

let live: Parent | undefined;
afterEach(async () => {
  await live?.stop();
  live = undefined;
  bodies.length = 0;
  childDone.clear();
  childDelay = {};
  childScript = undefined;
}, 20_000);

class Parent {
  events: any[] = [];
  child: ChildProcess;
  conn: RpcConnection;
  constructor(cwd = project) {
    const cmd = resolvePiCommand();
    const args = ["--mode", "rpc", "-e", resolve("src/index.ts"), "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
      "--offline", "--no-session", "--model", "fake/fake-model", "--approve"];
    this.child = spawn(cmd.command, [...cmd.args, ...args], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0" } });
    this.conn = new RpcConnection(this.child, { onEvent: (e) => this.events.push(e), onProtocolError: () => {} });
  }
  count = (type: string) => this.events.filter((e) => e.type === type).length;
  async prompt(message = "go") {
    const ack = await this.conn.send({ type: "prompt", message }, 30_000);
    expect(ack.success).toBe(true);
  }
  /** Parent has no turn in flight and nothing is queued: n agent_settled events seen. */
  settled = (n: number) => until(() => this.count("agent_settled") >= n, 60_000);
  childPids = () => Bun.spawnSync(["pgrep", "-P", String(this.child.pid)]).stdout.toString().split("\n").filter(Boolean).map(Number);
  async stop() {
    this.conn.closeInput();
    await Promise.race([this.conn.exited, Bun.sleep(8000)]);
    if (this.child.pid) try { process.kill(this.child.pid, "SIGKILL"); } catch {}
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("e2e: real parent pi + subagent extension", () => {
  T("(1,2,3,6) schema cost, background ids, single coalesced wake, child tools", async () => {
    childDelay = { A: 300, B: 800 };
    parentScript = async (b) => {
      if (isWake(b)) return textReply("wake handled");
      if (hasToolResult(b)) {
        await until(() => childDone.has("A") && childDone.has("B"));
        await Bun.sleep(1500); // let both children finish inside this turn
        return textReply("turn2 done");
      }
      return toolCallsReply([start("A"), start("B")]);
    };
    live = new Parent();
    await live.prompt();
    await live.settled(2); // turn 2 ends, then the wake turn ends

    const reqs = parentReqs();
    // (1) registered + cold cost
    const entry = reqs[0].tools.find((t: any) => t.function?.name === "subagent");
      const bytes = Buffer.byteLength(JSON.stringify(entry));
    console.log(`subagent tool entry: ${bytes} bytes, ~${Math.round(bytes / 4)} tokens`);
    expect(bytes).toBeGreaterThan(0);
    expect(entry.function.parameters.properties.action).toBeDefined();

    // (2) background start returns ids
    const acks = toolTexts(reqs[1]);
    expect(acks.length).toBe(2);
    for (const a of acks) expect(a).toMatch(/^started \S+ \(scout\)/);

    // (3) exactly one wake with both results, no further turn
    await Bun.sleep(2500);
    expect(parentReqs().length).toBe(3);
    expect(isWake(reqs[1])).toBe(false);
    expect(isWake(reqs[2])).toBe(true);
    const wake = blob(parentReqs()[2]);
    expect(wake).toContain("result-A");
    expect(wake).toContain("result-B");
    expect(wake).toContain("2 subagent jobs finished");
    expect(live.count("agent_end")).toBe(2);

    // (6) children: no subagent tool, only scout tools, scout prompt applied
    const kids = childReqs();
    expect(kids.length).toBe(2);
    for (const k of kids) {
      expect(k.tools.map((t: any) => t.function.name).sort()).toEqual(["grep", "read"]);
      expect(blob(k)).toContain("SCOUT-MARKER");
    }
  });

  for (const mode of ["inbox", "status"] as const) {
    T(`(4) mid-turn ${mode} after B finished: no wake for B, A wakes alone`, async () => {
      childDelay = { A: 6000, B: 300 };
      parentScript = async (b) => {
        if (isWake(b)) return textReply("wake handled");
        if (b.messages.some((m: any) => m.role === "tool" && /result-B/.test(String(m.content)))) return textReply("turn3 done");
        if (hasToolResult(b)) {
          await until(() => childDone.has("B"));
          await Bun.sleep(1500);
          const id = /started (\S+)/.exec(toolTexts(b)[1] ?? "")![1]!;
          return toolCallsReply([mode === "inbox"
            ? { name: "subagent", args: { action: "inbox" } }
            : { name: "subagent", args: { action: "status", id } }]);
        }
        return toolCallsReply([start("A"), start("B")]);
      };
      live = new Parent();
      await live.prompt();
      await live.settled(2); // turn ends, then A's wake turn ends
      const wakes = parentReqs().filter(isWake);
      expect(wakes.length).toBe(1);
      const w = blob(wakes[0]);
      expect(w).toContain("result-A");
      // B result appears once, as the tool result, never inside the wake message
      const wakeMsg = wakes[0].messages.findLast((m: any) => m.role === "user");
      expect(JSON.stringify(wakeMsg)).not.toContain("result-B");
      expect(JSON.stringify(wakeMsg)).toContain("1 subagent job finished");
      await Bun.sleep(1500);
      expect(live.count("agent_end")).toBe(2);
    });
  }

  T("(3b) staggered finishes while idle: every result delivered exactly once", async () => {
    childDelay = { A: 500, B: 3000 };
    parentScript = (b) => (isWake(b) || hasToolResult(b) ? textReply("ok") : toolCallsReply([start("A"), start("B")]));
    live = new Parent();
    await live.prompt();
    await until(() => childDone.has("B"));
    await Bun.sleep(4000);
    const last = parentReqs().at(-1)!;
    const all = blob(last);
    expect(all.match(/\[\S+ scout\] completed\s*\\nresult-A/g)?.length).toBe(1);
    expect(all.match(/\[\S+ scout\] completed\s*\\nresult-B/g)?.length).toBe(1);
    console.log(`staggered idle finishes: parent requests=${parentReqs().length}, wakes=${live.events.filter((e) => e.type === "agent_end").length - 1}`);
  });

  T("(5) wait:true returns result inline, no later wake", async () => {
    childDelay = { W: 500 };
    parentScript = (b) => (hasToolResult(b) ? textReply("done") : toolCallsReply([start("W", true)]));
    live = new Parent();
    await live.prompt();
    await live.settled(1);
    expect(toolTexts(parentReqs()[1])[0]).toContain("result-W");
    await Bun.sleep(2000);
    expect(parentReqs().length).toBe(2);
    expect(live.count("agent_end")).toBe(1);
  });

  T("(7) closing parent stdin leaves no leaked children", async () => {
    childDelay = { H: 60_000 };
    parentScript = (b) => (hasToolResult(b) ? textReply("ok") : toolCallsReply([start("H")]));
    live = new Parent();
    await live.prompt();
    await until(() => childReqs().length === 1);
    const pids = live.childPids();
    expect(pids.length).toBeGreaterThan(0);
    live.conn.closeInput();
    const exit = await Promise.race([live.conn.exited, Bun.sleep(15_000).then(() => "hung" as const)]);
    expect(exit).not.toBe("hung");
    await Bun.sleep(1000);
    for (const pid of pids) {
      expect(alive(pid)).toBe(false);
      expect(() => process.kill(-pid, 0)).toThrow();
    }
  });

  T("(8) isolate: child writes in worktree, parent untouched until diff + apply", async () => {
    writeFileSync(join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: Writes\ntools: read,write\n---\nbe brief.");
    const repo = mkdtempSync(join(tmpdir(), "pi-e2e-repo-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo }).toString();
    git("init", "-q");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const pi = join(repo, ".git", "pi-subagents");
    let seenInWorktree: string[] = [];
    let parentBeforeApply = true;
    childScript = (b) => {
      if (hasToolResult(b)) {
        // the write finished: snapshot where it landed
        seenInWorktree = existsSync(pi) ? readdirSync(pi).filter((d) => existsSync(join(pi, d, "note.txt"))) : [];
        parentBeforeApply = existsSync(join(repo, "note.txt"));
        return textReply("wrote note");
      }
      return toolCallsReply([{ name: "write", args: { path: "note.txt", content: "hello\n" } }]);
    };
    let id = "";
    parentScript = (b) => {
      const results = toolTexts(b);
      if (results.length === 0) return toolCallsReply([{ name: "subagent", args: { action: "start", agent: "worker", task: "make note", isolate: true, wait: true } }]);
      id = /\[(\S+) worker\]/.exec(results[0]!)?.[1] ?? "";
      if (results.length === 1) return toolCallsReply([{ name: "subagent", args: { action: "diff", id } }]);
      if (results.length === 2) return toolCallsReply([{ name: "subagent", args: { action: "apply", id } }]);
      return textReply("done");
    };
    live = new Parent(repo);
    await live.prompt();
    await live.settled(1);

    expect(seenInWorktree.length).toBe(1);
    expect(parentBeforeApply).toBe(false);
    const results = toolTexts(parentReqs().at(-1)!);
    expect(results[1]).toContain("note.txt");
    expect(results[2]).toContain("applied 1 file");
    expect(readFileSync(join(repo, "note.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(pi, seenInWorktree[0]!))).toBe(false);
  });
});
