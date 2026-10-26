/**
 * The runner's home directory: config, credentials, enrollment and status
 * files written by `install` / `run` and read by `status`.
 *
 *   macOS    ~/Library/Application Support/acp-web-proxy
 *   Linux    $XDG_CONFIG_HOME/acp-web-proxy  (~/.config/acp-web-proxy)
 *   Windows  %APPDATA%\acp-web-proxy
 *
 * ACP_WEB_PROXY_HOME overrides all of them.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function defaultHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.ACP_WEB_PROXY_HOME) return env.ACP_WEB_PROXY_HOME;
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "acp-web-proxy");
  if (platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "acp-web-proxy");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "acp-web-proxy");
}

export interface Credentials {
  carrier_url: string;
  runner_id: string;
  runner_name?: string;
  token: string;
}

export interface Enrollment {
  carrier_url: string;
  enrollment_id: string;
  poll_token: string;
  code: string;
  expires_at: string;
  interval_s: number;
  approve_url?: string | null;
}

export type RunnerState =
  | "enrolling"
  | "waiting_for_approval"
  | "approved"
  | "connecting"
  | "connected"
  | "disconnected"
  | "denied"
  | "expired"
  | "revoked"
  | "error";

export interface Status {
  state: RunnerState;
  carrier_url?: string;
  code?: string;
  expires_at?: string;
  approve_url?: string | null;
  runner_id?: string;
  runner_name?: string;
  agents?: string[];
  pid?: number;
  error?: string;
  updated_at: string;
}

export class Home {
  constructor(readonly dir: string = defaultHome()) {}

  get configFile(): string {
    return join(this.dir, "config.yaml");
  }
  get credentialsFile(): string {
    return join(this.dir, "credentials.json");
  }
  get enrollmentFile(): string {
    return join(this.dir, "enrollment.json");
  }
  get statusFile(): string {
    return join(this.dir, "status.json");
  }
  get logDir(): string {
    return join(this.dir, "logs");
  }
  get logFile(): string {
    return join(this.logDir, "proxy.log");
  }
  get stateDir(): string {
    return join(this.dir, "state");
  }

  ensure(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.logDir, { recursive: true });
  }

  readJson<T>(file: string): T | null {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  }

  /** Write atomically; `secret` files are readable by the owner only. */
  writeJson(file: string, value: unknown, secret = false): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: secret ? 0o600 : 0o644 });
    if (secret) {
      try {
        chmodSync(tmp, 0o600);
      } catch {
        /* Windows: %APPDATA% is already per-user */
      }
    }
    renameSync(tmp, file);
  }

  remove(file: string): void {
    rmSync(file, { force: true });
  }

  credentials(): Credentials | null {
    return this.readJson<Credentials>(this.credentialsFile);
  }
  enrollment(): Enrollment | null {
    return this.readJson<Enrollment>(this.enrollmentFile);
  }
  status(): Status | null {
    return this.readJson<Status>(this.statusFile);
  }

  setStatus(patch: Partial<Status> & { state: RunnerState }): Status {
    const prev = this.status() ?? ({} as Status);
    const next: Status = { ...prev, ...patch, updated_at: new Date().toISOString() };
    // Fields that belong to one state only must not linger into the next.
    if (next.state !== "waiting_for_approval") {
      delete next.code;
      delete next.expires_at;
      delete next.approve_url;
    }
    if (!("error" in patch)) delete next.error;
    this.writeJson(this.statusFile, next);
    return next;
  }

  exists(): boolean {
    return existsSync(this.dir);
  }
}
