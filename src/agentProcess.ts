/**
 * One ACP agent subprocess: newline-delimited JSON-RPC on stdin/stdout.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export interface SpawnSpec {
  command: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface AgentProcessEvents {
  frame: [string];
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
}

const STDERR_TAIL = 64 * 1024;

export class AgentProcess extends EventEmitter<AgentProcessEvents> {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private stderr = "";
  exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(spec: SpawnSpec) {
    super();
    const [cmd, ...args] = spec.command;
    this.child = spawn(cmd, args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so shutdown reaches the agent's children too.
      detached: process.platform !== "win32",
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });
    this.child.stdin.on("error", () => {
      /* EPIPE after exit is reported through `exit` */
    });
    this.child.on("error", (err) => {
      this.stderr = (this.stderr + `\n[spawn error] ${err.message}`).slice(-STDERR_TAIL);
      if (!this.exited) {
        this.exited = { code: -1, signal: null };
        this.emit("exit", this.exited);
      }
    });
    this.child.on("exit", (code, signal) => {
      if (this.buf.trim()) this.emit("frame", this.buf.trim());
      this.buf = "";
      if (!this.exited) {
        this.exited = { code, signal };
        this.emit("exit", this.exited);
      }
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stderrTail(): string {
    return this.stderr;
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.emit("frame", line);
    }
  }

  send(frame: string): boolean {
    if (this.exited || !this.child.stdin.writable) return false;
    // A frame must be one line: re-serialise anything that is not.
    const line = frame.includes("\n") ? JSON.stringify(JSON.parse(frame)) : frame;
    this.child.stdin.write(line + "\n");
    return true;
  }

  /** SIGTERM the process group, SIGKILL after `graceMs`. */
  async kill(graceMs = 5000): Promise<void> {
    if (this.exited) return;
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (this.child.pid && process.platform !== "win32") process.kill(-this.child.pid, sig);
        else this.child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const done = new Promise<void>((resolve) => this.once("exit", () => resolve()));
    signalGroup("SIGTERM");
    const timer = setTimeout(() => signalGroup("SIGKILL"), graceMs);
    await done;
    clearTimeout(timer);
  }
}
