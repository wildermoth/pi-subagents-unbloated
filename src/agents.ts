// Agent discovery. Run on demand only, never at import or registration.
// Precedence: project overrides user on a name collision. Within one dir,
// duplicate names resolve to the first by sorted filename, with a warning.
// Project agents load only when projectTrusted is true.
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { clip } from "./statusbar.ts";
import type { AgentDef } from "./types";

export interface DiscoverOpts {
  cwd: string;
  userDir?: string;
  projectTrusted: boolean;
}

export interface Discovered {
  agents: Map<string, AgentDef>;
  warnings: string[];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Nearest `.pi/agents` walking up from cwd, or undefined. */
async function findProjectDir(cwd: string): Promise<string | undefined> {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".pi", "agents");
    if (await isDir(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function toTools(v: unknown): string[] | undefined {
  const items = typeof v === "string" ? v.split(",") : Array.isArray(v) ? v : [];
  const tools = items
    .filter((t) => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
  return tools.length ? tools : undefined;
}

function toModel(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = v.trim();
  return m && m !== "inherit" ? m : undefined;
}

async function loadDir(dir: string, source: AgentDef["source"], warnings: string[]): Promise<Map<string, AgentDef>> {
  const out = new Map<string, AgentDef>();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${dir}: ${msg(e)}`);
    return out;
  }
  const files = entries
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => d.name)
    .sort();
  for (const file of files) {
    const path = join(dir, file);
    try {
      const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(await readFile(path, "utf8"));
      const name = typeof fm.name === "string" ? fm.name.trim() : "";
      const description = typeof fm.description === "string" ? fm.description.trim() : "";
      if (!name || !description) {
        warnings.push(`${path}: missing name or description`);
        continue;
      }
      const prior = out.get(name);
      if (prior) {
        warnings.push(`${path}: duplicate agent "${name}", keeping ${prior.path}`);
        continue;
      }
      out.set(name, { name, description, tools: toTools(fm.tools), model: toModel(fm.model), prompt: body, source, path });
    } catch (e) {
      warnings.push(`${path}: ${msg(e)}`);
    }
  }
  return out;
}

export async function discoverAgents(opts: DiscoverOpts): Promise<Discovered> {
  const warnings: string[] = [];
  const userDir = opts.userDir ?? join(getAgentDir(), "agents");
  const agents = await loadDir(userDir, "user", warnings);
  if (opts.projectTrusted) {
    const projectDir = await findProjectDir(opts.cwd);
    if (projectDir) for (const [name, def] of await loadDir(projectDir, "project", warnings)) agents.set(name, def);
  }
  return { agents, warnings };
}

export function resolveAgent(agents: Map<string, AgentDef>, name: string): AgentDef {
  const found = agents.get(name);
  if (found) return found;
  const names = [...agents.keys()].sort().join(", ") || "none";
  throw new Error(`Unknown agent "${name}". Available: ${names}`);
}

export function listAgents(agents: Map<string, AgentDef>): string {
  return [...agents.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `${a.name}: ${a.description}${a.source === "project" ? " (project)" : ""}`)
    .join("\n");
}

/** One short line per agent for the system prompt: enough to pick an agent without an `agents` call. */
export function briefAgents(agents: Map<string, AgentDef>, blurbChars = 60): string {
  return [...agents.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `${a.name}: ${clip(a.description, blurbChars)}`)
    .join("\n");
}
