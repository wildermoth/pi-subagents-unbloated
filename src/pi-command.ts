/** Finds the Pi executable to spawn as a child: PI_BIN, this process's own Pi, the installed package, or PATH. */
import { existsSync, readFileSync } from "node:fs";
import { basename, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  read?: (p: string) => string | undefined;
  /** Absolute path of some file inside the Pi package, or undefined when not installed. */
  resolvePackage?: () => string | undefined;
  /** Defaults to process.execPath; Pi's bundle needs a real node, not e.g. bun. */
  execPath?: string;
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const isPiEntry = (p: string) => p.includes("pi-coding-agent") || /^(pi|cli)(\.[cm]?js)?$/.test(basename(p));

function defaultResolvePackage(): string | undefined {
  try {
    const url = import.meta.resolve(PI_PACKAGE);
    return url.startsWith("file:") ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

const isNode = (exec: string) => /^node(\.exe)?$/i.test(basename(exec.replace(/\\/g, "/")));

const defaultExists = (p: string) => existsSync(p);
function defaultRead(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/** Walk up from a file inside the package to its package.json and return the bin.pi script. */
function packageBin(o: Required<ResolveOptions>, P: typeof posix): string | undefined {
  const file = o.resolvePackage();
  if (!file) return undefined;
  for (let dir = P.dirname(file); ; dir = P.dirname(dir)) {
    const text = o.exists(P.join(dir, "package.json")) ? o.read(P.join(dir, "package.json")) : undefined;
    if (text) {
      try {
        const pkg = JSON.parse(text) as { name?: unknown; bin?: unknown };
        if (pkg.name === PI_PACKAGE) {
          const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin as { pi?: unknown } | null | undefined)?.pi;
          const target = typeof bin === "string" ? P.resolve(dir, bin) : undefined;
          return target && o.exists(target) ? target : undefined;
        }
      } catch {
        // unreadable package.json: keep walking
      }
    }
    if (P.dirname(dir) === dir) return undefined;
  }
}

/** Find an executable named `name` on PATH (PATHEXT on Windows) without shelling out. */
function findOnPath(env: NodeJS.ProcessEnv, win: boolean, o: Required<ResolveOptions>): string | undefined {
  const P = win ? win32 : posix;
  const pathVar = win ? (env.PATH ?? env.Path ?? env.path ?? "") : (env.PATH ?? "");
  const exts = win ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of pathVar.split(win ? ";" : ":").filter(Boolean)) {
    for (const ext of exts) {
      const p = P.join(dir.replace(/^"|"$/g, ""), "pi" + ext);
      if (o.exists(p)) return p;
    }
  }
  return undefined;
}

/** Turn a resolved Windows path into a spawnable command; .cmd/.bat shims become node + target script. */
function windowsCommand(p: string, o: Required<ResolveOptions>): { command: string; args: string[] } {
  const node = isNode(o.execPath) ? o.execPath : "node";
  if (/\.[cm]?js$/i.test(p)) return { command: node, args: [p] };
  if (!/\.(cmd|bat)$/i.test(p)) return { command: p, args: [] };
  const m = /["']?%~?dp0%?[\\/]+([^"'%\r\n]+?\.[cm]?js)["']?/i.exec(o.read(p) ?? "");
  const target = m ? win32.resolve(win32.dirname(p), m[1]!) : undefined;
  if (!target || !o.exists(target)) {
    throw new Error(`cannot launch Pi from shim ${p}: no target .js found in it; set PI_BIN to the Pi cli.js or an .exe`);
  }
  return { command: node, args: [target] };
}

/** PI_BIN, then this process's own Pi entry, then the installed Pi package, then `pi` on PATH. */
export function resolvePiCommand(
  env: NodeJS.ProcessEnv = process.env,
  argv1: string | undefined = process.argv[1],
  opts: ResolveOptions = {},
): { command: string; args: string[] } {
  const platform = opts.platform ?? process.platform;
  const win = platform === "win32";
  const o: Required<ResolveOptions> = {
    platform,
    exists: opts.exists ?? defaultExists,
    read: opts.read ?? defaultRead,
    resolvePackage: opts.resolvePackage ?? defaultResolvePackage,
    execPath: opts.execPath ?? process.execPath,
  };
  const fromPath = (p: string) => (win ? windowsCommand(p, o) : { command: p, args: [] });
  if (env.PI_BIN) return fromPath(env.PI_BIN);
  // Only trust argv[1] when it looks like Pi's entry point (not e.g. a test runner script)
  if (argv1 && isPiEntry(argv1)) return { command: process.execPath, args: [argv1] };
  let pkgBin: string | undefined;
  try {
    pkgBin = isNode(o.execPath) ? packageBin(o, win ? win32 : posix) : undefined;
  } catch {
    pkgBin = undefined;
  }
  if (pkgBin) return { command: o.execPath, args: [pkgBin] };
  if (!win) return { command: "pi", args: [] };
  const found = findOnPath(env, true, o);
  if (!found) throw new Error("cannot find `pi` on PATH (checked PATHEXT); install Pi or set PI_BIN");
  return windowsCommand(found, o);
}
