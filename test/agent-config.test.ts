import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureAgent, modelChoices, setFrontmatterField, type MenuContext } from "../src/agent-config.ts";
import { discoverAgents } from "../src/agents.ts";

const doc = "---\nname: a\ndescription: d\nmodel: old/one\n---\nBody\nmodel: not frontmatter\n";

describe("setFrontmatterField", () => {
  test("replaces an existing key in place of the old line and leaves the body alone", () => {
    expect(setFrontmatterField(doc, "model", '"new/two"')).toBe(
      '---\nname: a\ndescription: d\nmodel: "new/two"\n---\nBody\nmodel: not frontmatter\n',
    );
  });
  test("adds a missing key and removes one with null", () => {
    expect(setFrontmatterField(doc, "thinking", "high")).toContain("model: old/one\nthinking: high\n---\n");
    expect(setFrontmatterField(doc, "model", null)).toBe("---\nname: a\ndescription: d\n---\nBody\nmodel: not frontmatter\n");
  });
  test("keeps CRLF line endings", () => {
    const out = setFrontmatterField(doc.replaceAll("\n", "\r\n"), "thinking", "low");
    expect(out).toContain("thinking: low\r\n---\r\n");
    expect(out.replaceAll("\r\n", "")).not.toContain("\n");
  });
  test("does not match a key that merely starts with the same letters", () => {
    expect(setFrontmatterField("---\nmodels: keep\n---\n", "model", "x")).toBe("---\nmodels: keep\nmodel: x\n---\n");
  });
  test("refuses text without a frontmatter block", () => {
    expect(() => setFrontmatterField("just text", "model", "x")).toThrow("no frontmatter");
  });
});

const m = (provider: string, id: string) => ({ provider, id });

describe("modelChoices", () => {
  const registry = { getAvailable: () => [m("p", "b"), m("p", "a"), m("q", "z"), m("p", "a")] };
  test("lists everything available, sorted and de-duplicated, when nothing is scoped", () => {
    expect(modelChoices({ modelRegistry: registry, scopedModels: [] })).toEqual(["p/a", "p/b", "q/z"]);
  });
  test("prefers the user's scoped models", () => {
    expect(modelChoices({ modelRegistry: registry, scopedModels: [{ model: m("q", "z") }] })).toEqual(["q/z"]);
  });
});

describe("configureAgent", () => {
  let dir: string;
  beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), "agentcfg-"))));
  afterEach(() => rm(dir, { recursive: true, force: true }));

  /** A menu context answering each prompt in order; undefined means the user pressed escape. */
  function menu(answers: (string | undefined)[]) {
    const asked: { title: string; options: string[] }[] = [];
    const notes: string[] = [];
    const ctx: MenuContext = {
      ui: {
        select: async (title, options) => (asked.push({ title, options }), answers.shift()),
        notify: (msg) => void notes.push(msg),
      },
      modelRegistry: { getAvailable: () => [m("openrouter", "meta/muse:fast"), m("anthropic", "sonnet")] },
      scopedModels: [],
    };
    return { ctx, asked, notes };
  }
  const load = async () => [...(await discoverAgents({ cwd: dir, userDir: dir, projectTrusted: false })).agents.values()];

  test("writes the chosen model (quoted, so colons survive) and thinking, and discovery reads them back", async () => {
    await writeFile(join(dir, "a.md"), "---\nname: a\ndescription: d\n---\nBody");
    const { ctx, notes } = menu(["openrouter/meta/muse:fast", "high"]);
    const next = await configureAgent(ctx, await load());
    expect(next).toMatchObject({ model: "openrouter/meta/muse:fast", thinking: "high" });
    expect((await load())[0]).toMatchObject({ name: "a", model: "openrouter/meta/muse:fast", thinking: "high" });
    expect(await readFile(join(dir, "a.md"), "utf8")).toContain('model: "openrouter/meta/muse:fast"');
    expect(notes[0]).toContain("a:");
  });

  test("inherit clears both fields; the menu offers inherit first and shows current settings", async () => {
    await writeFile(join(dir, "a.md"), "---\nname: a\ndescription: d\nmodel: x/y\nthinking: low\n---\nBody");
    const { ctx, asked } = menu(["inherit", "inherit"]);
    await configureAgent(ctx, await load());
    const text = await readFile(join(dir, "a.md"), "utf8");
    expect(text).not.toContain("model:");
    expect(text).not.toContain("thinking:");
    expect(asked[0]!.options[0]).toBe("inherit");
    expect(asked[0]!.options.slice(1)).toEqual(["anthropic/sonnet", "openrouter/meta/muse:fast"]);
  });

  test("backing out at any step changes nothing", async () => {
    await writeFile(join(dir, "a.md"), "---\nname: a\ndescription: d\n---\nBody");
    const agents = await load();
    for (const answers of [[undefined], ["anthropic/sonnet", undefined]]) {
      const { ctx } = menu(answers);
      expect(await configureAgent(ctx, agents)).toBeUndefined();
    }
    expect(await readFile(join(dir, "a.md"), "utf8")).toBe("---\nname: a\ndescription: d\n---\nBody");
  });

  test("with several agents it asks which one first, and backing out there changes nothing", async () => {
    await writeFile(join(dir, "a.md"), "---\nname: a\ndescription: d\n---\nBody");
    await writeFile(join(dir, "b.md"), "---\nname: b\ndescription: d\n---\nBody");
    const { ctx, asked } = menu([undefined]);
    expect(await configureAgent(ctx, await load())).toBeUndefined();
    expect(asked[0]!.title).toBe("Agent");
    expect(asked[0]!.options).toEqual(["a  (inherit, inherit)", "b  (inherit, inherit)"]);
  });

  test("an unwritable file is reported, not thrown", async () => {
    const { ctx, notes } = menu(["anthropic/sonnet", "off"]);
    const agent = { name: "a", description: "d", model: "old/one", prompt: "", source: "user" as const, path: join(dir, "missing.md") };
    expect(await configureAgent(ctx, [agent])).toBeUndefined();
    expect(notes[0]).toContain("Could not update");
  });
});
