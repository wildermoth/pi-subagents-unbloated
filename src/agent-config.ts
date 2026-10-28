/** The `/subagent-model` menu: pick an agent, a model and a thinking level, and write them back to the agent file. */
import { readFile, writeFile } from "node:fs/promises";
import { THINKING_LEVELS } from "./agents.ts";
import type { AgentDef } from "./types.ts";

const INHERIT = "inherit";

/** Sets `key: value` inside the leading frontmatter block, or removes the key when value is null. Everything else is untouched. */
export function setFrontmatterField(text: string, key: string, value: string | null): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) throw new Error("no frontmatter block");
  const head = lines.slice(1, end).filter((l) => !new RegExp(`^${key}\\s*:`).test(l));
  if (value !== null) head.push(`${key}: ${value}`);
  return [lines[0], ...head, ...lines.slice(end)].join(eol);
}

/** The subset of Pi's command context the menu uses, so tests can drive it. */
export interface MenuContext {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  modelRegistry: { getAvailable(): { provider: string; id: string }[] };
  /** Models the user scoped with `enabledModels` / `--models`; empty means everything available. */
  scopedModels: readonly { model: { provider: string; id: string } }[];
}

/** Models worth offering: the user's scoped set when there is one, else everything with credentials. */
export function modelChoices(ctx: Pick<MenuContext, "modelRegistry" | "scopedModels">): string[] {
  const models = ctx.scopedModels.length ? ctx.scopedModels.map((s) => s.model) : ctx.modelRegistry.getAvailable();
  return [...new Set(models.map((m) => `${m.provider}/${m.id}`))].sort();
}

const describe = (a: AgentDef) => `${a.name}  (${a.model ?? INHERIT}, ${a.thinking ?? INHERIT})`;

/** Returns the changed agent, or undefined when the user backed out at any step. */
export async function configureAgent(ctx: MenuContext, agents: AgentDef[]): Promise<AgentDef | undefined> {
  const byLabel = new Map(agents.map((a) => [describe(a), a]));
  // One candidate (opened from the agent list) needs no "which agent" question.
  const agent = agents.length === 1 ? agents[0] : byLabel.get((await ctx.ui.select("Agent", [...byLabel.keys()])) ?? "");
  if (!agent) return undefined;
  const model = await ctx.ui.select(`Model for ${agent.name}`, [INHERIT, ...modelChoices(ctx)]);
  if (!model) return undefined;
  const thinking = await ctx.ui.select(`Thinking level for ${agent.name}`, [INHERIT, ...THINKING_LEVELS]);
  if (!thinking) return undefined;

  const next = { ...agent, model: model === INHERIT ? undefined : model, thinking: thinking === INHERIT ? undefined : thinking };
  try {
    let text = setFrontmatterField(await readFile(agent.path, "utf8"), "model", next.model ? JSON.stringify(next.model) : null);
    text = setFrontmatterField(text, "thinking", next.thinking ?? null);
    await writeFile(agent.path, text);
  } catch (e) {
    ctx.ui.notify(`Could not update ${agent.path}: ${e instanceof Error ? e.message : String(e)}`, "error");
    return undefined;
  }
  ctx.ui.notify(`${agent.name}: ${next.model ?? INHERIT}, thinking ${next.thinking ?? INHERIT}`, "info");
  return next;
}
