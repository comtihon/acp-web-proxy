import { spawn } from "node:child_process";
import type { HookSpec } from "./config.js";

export interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a hook with `input` on stdin; never throws for a non-zero exit. */
export function runHook(
  hook: HookSpec,
  input: string,
  env: Record<string, string>,
  cwd?: string,
): Promise<HookResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = hook.command;
    const child = spawn(cmd, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = (hook.timeout_s ?? 300) * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (c: string) => { stdout += c; });
    child.stderr.setEncoding("utf8").on("data", (c: string) => { stderr = (stderr + c).slice(-64 * 1024); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\n[spawn error] ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export interface PrepareOutput {
  env?: Record<string, string>;
  cwd?: string;
  args?: string[];
  command?: string[];
}

/** The last JSON object a prepare hook printed (hooks may log before it). */
export function parsePrepareOutput(stdout: string): PrepareOutput {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as PrepareOutput;
  } catch {
    const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith("{")) {
        try {
          return JSON.parse(lines[i]) as PrepareOutput;
        } catch {
          /* keep looking */
        }
      }
    }
    throw new Error("prepare hook printed no JSON object on stdout");
  }
}
