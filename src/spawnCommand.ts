/**
 * Cross-platform process spawning.
 *
 * On Windows, `npx`, `claude`, `codex` … are `.cmd` shims. Node refuses to
 * spawn those without a shell (CVE-2024-27980), and `spawn("npx")` without
 * PATHEXT resolution does not find them at all. So on win32 the command is
 * resolved through PATH/PATHEXT and anything that is not a real executable runs
 * through `cmd.exe /d /s /c` with every argument escaped (the scheme
 * cross-spawn uses). Elsewhere the argv is spawned as is.
 */

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, normalize } from "node:path";

export interface ResolvedSpawn {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

const META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCommand(cmd: string): string {
  return cmd.replace(META, "^$1");
}

function escapeArgument(arg: string, doubleEscape: boolean): string {
  let a = `${arg}`;
  // Backslashes before a quote, and trailing ones, are doubled; quotes escaped.
  a = a.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  a = a.replace(/(?=(\\+?)?)\1$/, "$1$1");
  a = `"${a}"`;
  a = a.replace(META, "^$1");
  if (doubleEscape) a = a.replace(META, "^$1");
  return a;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Find `cmd` the way cmd.exe would: PATH × PATHEXT. */
export function whichWindows(cmd: string, env: NodeJS.ProcessEnv): string | null {
  // Both cases: Windows matches either; a case-sensitive test filesystem does not.
  const exts = (env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).flatMap((e) => [e, e.toLowerCase()]);
  const candidates = extname(cmd) ? [""] : ["", ...exts];
  const dirs = isAbsolute(cmd) || cmd.includes("\\") || cmd.includes("/")
    ? [""]
    : ["", ...(env.PATH ?? env.Path ?? "").split(";").filter(Boolean)];
  for (const dir of dirs) {
    for (const ext of candidates) {
      const p = dir ? join(dir, cmd + ext) : cmd + ext;
      // A bare name with no extension is not runnable on Windows.
      if (!ext && !extname(p)) continue;
      if (isFile(p)) return p;
    }
  }
  return null;
}

/** Find `cmd` on PATH (any platform). */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  if (platform === "win32") return whichWindows(cmd, env);
  if (cmd.includes("/")) return existsSync(cmd) ? cmd : null;
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const p = join(dir, cmd);
    if (isFile(p)) return p;
  }
  return null;
}

export function resolveSpawn(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedSpawn {
  const [cmd, ...args] = argv;
  if (platform !== "win32") return { file: cmd, args };
  const resolved = whichWindows(cmd, env) ?? cmd;
  if (/\.(?:com|exe)$/i.test(resolved)) return { file: resolved, args };
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const line = [escapeCommand(normalize(resolved)), ...args.map((a) => escapeArgument(a, doubleEscape))].join(" ");
  return {
    file: env.comspec ?? env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/** `spawn(argv)` that also works for `.cmd` shims on Windows. */
export function spawnArgv(argv: string[], options: SpawnOptions & { env?: NodeJS.ProcessEnv }): ChildProcess {
  const r = resolveSpawn(argv, options.env ?? process.env);
  return spawn(r.file, r.args, { ...options, windowsVerbatimArguments: r.windowsVerbatimArguments });
}

/** Kill a process and everything it started. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      // There are no process groups to signal; taskkill walks the tree.
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}
