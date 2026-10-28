import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { JsonlFramer, RpcConnection, RpcError } from "../src/protocol.ts";

function framer(max = 1000) {
  const lines: string[] = [];
  let overflow = 0;
  const f = new JsonlFramer({ maxRecordChars: max, onLine: (l) => lines.push(l), onOverflow: () => overflow++ });
  return { f, lines, overflows: () => overflow };
}

describe("JsonlFramer", () => {
  test("partial frames", () => {
    const { f, lines } = framer();
    f.push(Buffer.from('{"a":'));
    expect(lines).toEqual([]);
    f.push(Buffer.from("1}\n"));
    expect(lines).toEqual(['{"a":1}']);
  });
  test("multiple records per chunk", () => {
    const { f, lines } = framer();
    f.push(Buffer.from("a\nb\nc"));
    expect(lines).toEqual(["a", "b"]);
    f.push(Buffer.from("\n"));
    expect(lines).toEqual(["a", "b", "c"]);
  });
  test("split UTF-8 across chunks", () => {
    const { f, lines } = framer();
    const b = Buffer.from("\u{1F600}x\n");
    for (let i = 0; i < b.length; i++) f.push(b.subarray(i, i + 1));
    expect(lines).toEqual(["\u{1F600}x"]);
  });
  test("CRLF stripped, empty lines skipped", () => {
    const { f, lines } = framer();
    f.push(Buffer.from("a\r\n\r\nb\n"));
    expect(lines).toEqual(["a", "b"]);
  });
  test("U+2028/2029 do not split", () => {
    const { f, lines } = framer();
    f.push(Buffer.from("a b c\n"));
    expect(lines).toEqual(["a b c"]);
  });
  test("unterminated record flushed at end", () => {
    const { f, lines } = framer();
    f.push(Buffer.from("tail"));
    f.end();
    expect(lines).toEqual(["tail"]);
  });
  test("overflow without newline", () => {
    const { f, lines, overflows } = framer(10);
    f.push(Buffer.from("x".repeat(11)));
    expect(overflows()).toBe(1);
    f.push(Buffer.from("more\n"));
    expect(lines).toEqual([]);
    expect(overflows()).toBe(1);
  });
  test("overflow of a complete long line", () => {
    const { f, overflows } = framer(10);
    f.push(Buffer.from("x".repeat(50) + "\n"));
    expect(overflows()).toBe(1);
  });
  test("exactly max is fine", () => {
    const { f, lines, overflows } = framer(10);
    f.push(Buffer.from("x".repeat(10) + "\n"));
    expect(lines.length).toBe(1);
    expect(overflows()).toBe(0);
  });
});

const FAKE = ["test/fake-pi.ts"];
function conn(args: string[], extra: Partial<ConstructorParameters<typeof RpcConnection>[1]> = {}) {
  const events: any[] = [];
  const errors: Error[] = [];
  const child = spawn(process.execPath, [...FAKE, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const c = new RpcConnection(child, { onEvent: (e) => events.push(e), onProtocolError: (e) => errors.push(e), ...extra });
  return { c, events, errors, child };
}

describe("RpcConnection", () => {
  test("correlates responses and delivers events", async () => {
    const { c, events } = conn(["--fake=normal"]);
    const r = await c.send({ type: "get_state" }, 5000);
    expect(r.success).toBe(true);
    const p = await c.send({ type: "prompt", message: "hi" }, 5000);
    expect(p.data!.disposition).toBe("started");
    c.closeInput();
    await c.exited;
    expect(events.map((e) => e.type)).toContain("agent_settled");
  });
  test("request deadline", async () => {
    const { c } = conn(["--fake=never-acks"]);
    const err = await c.send({ type: "prompt", message: "x" }, 100).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe("timeout");
    c.closeInput();
    await c.exited;
  });
  test("pending bound", async () => {
    const { c } = conn(["--fake=never-acks"], { maxPending: 2 });
    const a = c.send({ type: "prompt", message: "x" }, 300).catch((e) => e);
    const b = c.send({ type: "prompt", message: "x" }, 300).catch((e) => e);
    const third = await c.send({ type: "get_state" }, 300).catch((e) => e);
    expect(third.code).toBe("busy");
    await Promise.all([a, b]);
    c.closeInput();
    await c.exited;
  });
  test("rejects pending when child exits", async () => {
    const { c } = conn(["--fake=exit-before-ack"]);
    const err = await c.send({ type: "prompt", message: "x" }, 5000).catch((e) => e);
    expect(err.code).toBe("exit");
    const info = await c.exited;
    expect(info.code).toBe(3);
    expect(c.stderrTail()).toContain("boom");
  });
  test("malformed JSON reported, not thrown", async () => {
    const { c, errors } = conn(["--fake=malformed"]);
    await c.send({ type: "prompt", message: "x" }, 5000);
    await Bun.sleep(100);
    expect(errors.some((e) => /malformed/.test(e.message))).toBe(true);
    c.closeInput();
    await c.exited;
  });
  test("record overflow reported", async () => {
    const { c, errors } = conn(["--fake=overflow"], { maxRecordChars: 1024 * 1024 });
    await c.send({ type: "prompt", message: "x" }, 5000);
    await Bun.sleep(300);
    expect(errors.some((e) => /size limit/.test(e.message))).toBe(true);
    c.closeInput();
    await c.exited;
  });
  test("stderr tail is bounded and stdout still drains", async () => {
    const { c, events } = conn(["--fake=stderr-flood"], { stderrTailBytes: 1024 });
    await c.send({ type: "prompt", message: "x" }, 5000);
    c.closeInput();
    await c.exited;
    expect(c.stderrTail().length).toBeLessThanOrEqual(1024);
    expect(events.some((e) => e.type === "agent_settled")).toBe(true);
  });
  test("send after exit rejects; EPIPE does not crash", async () => {
    const { c, child } = conn(["--fake=exit-before-ack"]);
    await c.send({ type: "prompt", message: "x" }, 5000).catch(() => {});
    await c.exited;
    const err = await c.send({ type: "get_state" }, 1000).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    c.sendNoReply({ type: "x" });
    expect(child.exitCode).toBe(3);
  });
  test("spawn failure resolves exited with spawnError", async () => {
    const child = spawn("/nonexistent/pi-binary", [], { stdio: ["pipe", "pipe", "pipe"] });
    const c = new RpcConnection(child, { onEvent() {}, onProtocolError() {} });
    const err = await c.send({ type: "get_state" }, 2000).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((await c.exited).spawnError).toBeDefined();
  });
});
