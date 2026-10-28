import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefAgents, discoverAgents, listAgents, resolveAgent } from "../src/agents";

let root: string;
let userDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agents-test-"));
  userDir = join(root, "user");
  await mkdir(userDir, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const md = (fm: string, body = "Body") => `---\n${fm}\n---\n${body}\n`;

async function projectDir(base = root): Promise<string> {
  const d = join(base, ".pi", "agents");
  await mkdir(d, { recursive: true });
  return d;
}

test("parses a basic agent", async () => {
  await writeFile(join(userDir, "a.md"), md("name: scout\ndescription: Finds things", "Do it."));
  const { agents, warnings } = await discoverAgents({ cwd: root, userDir, projectTrusted: false });
  expect(warnings).toEqual([]);
  const a = agents.get("scout")!;
  expect(a.description).toBe("Finds things");
  expect(a.prompt.trim()).toBe("Do it.");
  expect(a.source).toBe("user");
  expect(a.path).toBe(join(userDir, "a.md"));
  expect(a.tools).toBeUndefined();
  expect(a.model).toBeUndefined();
});

test("tools accepts string or array, empty is undefined", async () => {
  await writeFile(join(userDir, "a.md"), md("name: a\ndescription: d\ntools: read, grep"));
  await writeFile(join(userDir, "b.md"), md("name: b\ndescription: d\ntools: [read, bash]"));
  await writeFile(join(userDir, "c.md"), md("name: c\ndescription: d\ntools: ''"));
  await writeFile(join(userDir, "d.md"), md("name: d\ndescription: d\ntools: []"));
  const { agents } = await discoverAgents({ cwd: root, userDir, projectTrusted: false });
  expect(agents.get("a")!.tools).toEqual(["read", "grep"]);
  expect(agents.get("b")!.tools).toEqual(["read", "bash"]);
  expect(agents.get("c")!.tools).toBeUndefined();
  expect(agents.get("d")!.tools).toBeUndefined();
});

test("model inherit or missing is undefined, explicit kept", async () => {
  await writeFile(join(userDir, "a.md"), md("name: a\ndescription: d\nmodel: inherit"));
  await writeFile(join(userDir, "b.md"), md("name: b\ndescription: d\nmodel: anthropic/sonnet"));
  const { agents } = await discoverAgents({ cwd: root, userDir, projectTrusted: false });
  expect(agents.get("a")!.model).toBeUndefined();
  expect(agents.get("b")!.model).toBe("anthropic/sonnet");
});

test("missing fields warn with path and skip; unknown fields ignored", async () => {
  await writeFile(join(userDir, "noname.md"), md("description: d"));
  await writeFile(join(userDir, "nodesc.md"), md("name: x"));
  await writeFile(join(userDir, "ok.md"), md("name: ok\ndescription: d\nfoo: bar"));
  const { agents, warnings } = await discoverAgents({ cwd: root, userDir, projectTrusted: false });
  expect([...agents.keys()]).toEqual(["ok"]);
  expect(warnings).toHaveLength(2);
  expect(warnings.some((w) => w.includes("noname.md"))).toBe(true);
  expect(warnings.some((w) => w.includes("nodesc.md"))).toBe(true);
});

test("malformed frontmatter warns and does not throw", async () => {
  await writeFile(join(userDir, "bad.md"), "---\nname: [unclosed\ndescription: : :\n---\nbody");
  await writeFile(join(userDir, "ok.md"), md("name: ok\ndescription: d"));
  const { agents, warnings } = await discoverAgents({ cwd: root, userDir, projectTrusted: false });
  expect([...agents.keys()]).toEqual(["ok"]);
  expect(warnings.some((w) => w.includes("bad.md"))).toBe(true);
});

test("ignores non-md files and missing user dir", async () => {
  await writeFile(join(userDir, "notes.txt"), md("name: t\ndescription: d"));
  const { agents, warnings } = await discoverAgents({ cwd: root, userDir: join(root, "nope"), projectTrusted: false });
  expect(agents.size).toBe(0);
  expect(warnings).toEqual([]);
  expect((await discoverAgents({ cwd: root, userDir, projectTrusted: false })).agents.size).toBe(0);
});

test("project overrides user when trusted", async () => {
  await writeFile(join(userDir, "a.md"), md("name: a\ndescription: user one"));
  await writeFile(join(userDir, "u.md"), md("name: u\ndescription: only user"));
  await writeFile(join(await projectDir(), "a.md"), md("name: a\ndescription: project one"));
  const { agents } = await discoverAgents({ cwd: root, userDir, projectTrusted: true });
  expect(agents.get("a")!.source).toBe("project");
  expect(agents.get("a")!.description).toBe("project one");
  expect(agents.get("u")!.source).toBe("user");
});

test("untrusted project agents are not loaded", async () => {
  await writeFile(join(userDir, "a.md"), md("name: a\ndescription: user one"));
  await writeFile(join(await projectDir(), "a.md"), md("name: a\ndescription: project one"));
  await writeFile(join(await projectDir(), "p.md"), md("name: p\ndescription: proj only"));
  const { agents } = await discoverAgents({ cwd: root, userDir, projectTrusted: false });
  expect(agents.get("a")!.source).toBe("user");
  expect(agents.has("p")).toBe(false);
});

test("duplicate names in one dir: first sorted filename wins with warning", async () => {
  await writeFile(join(userDir, "b.md"), md("name: dup\ndescription: second"));
  await writeFile(join(userDir, "a.md"), md("name: dup\ndescription: first"));
  const { agents, warnings } = await discoverAgents({ cwd: root, userDir, projectTrusted: false });
  expect(agents.get("dup")!.description).toBe("first");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("b.md");
});

test("walks up to the nearest .pi/agents", async () => {
  await writeFile(join(await projectDir(), "far.md"), md("name: far\ndescription: d"));
  const mid = join(root, "mid");
  await writeFile(join(await projectDir(mid), "near.md"), md("name: near\ndescription: d"));
  const deep = join(mid, "x", "y");
  await mkdir(deep, { recursive: true });
  const { agents } = await discoverAgents({ cwd: deep, userDir, projectTrusted: true });
  expect(agents.has("near")).toBe(true);
  expect(agents.has("far")).toBe(false);
});

test("resolveAgent returns def or throws listing names", async () => {
  await writeFile(join(userDir, "a.md"), md("name: beta\ndescription: d"));
  await writeFile(join(userDir, "b.md"), md("name: alpha\ndescription: d"));
  const { agents } = await discoverAgents({ cwd: root, userDir, projectTrusted: false });
  expect(resolveAgent(agents, "alpha").name).toBe("alpha");
  expect(() => resolveAgent(agents, "nope")).toThrow('Unknown agent "nope". Available: alpha, beta');
  expect(() => resolveAgent(new Map(), "x")).toThrow("Available: none");
});

test("listAgents tags project agents", async () => {
  await writeFile(join(userDir, "a.md"), md("name: a\ndescription: user one"));
  await writeFile(join(await projectDir(), "p.md"), md("name: p\ndescription: proj one"));
  const { agents } = await discoverAgents({ cwd: root, userDir, projectTrusted: true });
  expect(listAgents(agents)).toBe("a: user one\np: proj one (project)");
});

test("briefAgents gives one clipped line per agent, sorted", async () => {
  await writeFile(join(userDir, "b.md"), md("name: zed\ndescription: " + "long ".repeat(40)));
  await writeFile(join(userDir, "a.md"), md("name: alpha\ndescription: Short one"));
  const { agents } = await discoverAgents({ cwd: root, userDir, projectTrusted: false });
  const lines = briefAgents(agents).split("\n");
  expect(lines[0]).toBe("alpha: Short one");
  expect(lines[1]).toMatch(/^zed: long long/);
  expect([...lines[1]!.slice("zed: ".length)].length).toBe(60);
  expect(lines[1]!.endsWith("…")).toBe(true);
});

test('inprocess frontmatter accepts true or "true" and defaults to off', async () => {
  await writeFile(join(userDir, "a.md"), md("name: a\ndescription: d\ninprocess: true"));
  await writeFile(join(userDir, "b.md"), md('name: b\ndescription: d\ninprocess: "true"'));
  await writeFile(join(userDir, "c.md"), md("name: c\ndescription: d\ninprocess: false"));
  await writeFile(join(userDir, "d.md"), md("name: d\ndescription: d"));
  const { agents } = await discoverAgents({ cwd: root, userDir, projectTrusted: false });
  expect([...agents.values()].map((a) => [a.name, a.inprocess])).toEqual([
    ["a", true],
    ["b", true],
    ["c", undefined],
    ["d", undefined],
  ]);
});
