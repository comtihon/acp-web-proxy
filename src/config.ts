/**
 * Proxy configuration.
 *
 * Loaded from a YAML/JSON file (`--config` or ACP_PROXY_CONFIG). Any string
 * value of the form `env:NAME` is replaced with that environment variable, so
 * secrets stay out of the file.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface HookSpec {
  /** argv; the first element is the executable. */
  command: string[];
  /** Seconds before the hook is killed. */
  timeout_s?: number;
}

export interface AgentSpec {
  /** argv of the ACP agent (speaks newline-delimited JSON-RPC on stdio). */
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
  hooks?: {
    /**
     * Runs before the agent starts. Receives the launch config (from
     * `_proxy/launch`) as JSON on stdin and in ACP_PROXY_CONFIG_FILE. May print
     * a JSON object on stdout: {env?, cwd?, args?, command?} merged into the
     * agent's spawn. This is where a deployment turns the caller's config
     * (tools, MCP servers, credentials, workspace restore) into files and env
     * the agent understands.
     */
    prepare?: HookSpec;
    /**
     * Runs after every `session/prompt` turn, *before* the turn's response is
     * forwarded — e.g. to persist the workspace, so the client never sees a
     * finished turn whose files are not saved yet.
     */
    after_prompt?: HookSpec;
    /** Runs when the agent is shut down (idle timeout, `_proxy/shutdown`). */
    shutdown?: HookSpec;
  };
}

export interface DialSpec {
  /** Control endpoint, e.g. wss://carrier.example.com/api/v1/acp/runners/connect */
  url: string;
  token?: string;
  runner_id: string;
  labels?: Record<string, string>;
  /** Seconds between reconnect attempts of the control socket. */
  reconnect_s?: number;
}

export interface ProxyConfig {
  listen?: { host: string; port: number; path: string } | null;
  /** Bearer tokens accepted on the WebSocket (listen mode). Empty = no auth (refused unless allow_unauthenticated). */
  tokens: string[];
  allow_unauthenticated: boolean;
  agents: Record<string, AgentSpec>;
  default_agent: string;
  /** Seconds an agent survives with no client attached (reconnect window). */
  idle_timeout_s: number;
  /** Frames kept per connection for replay after a reconnect. */
  replay_buffer: number;
  /** Max WebSocket message size in bytes. */
  max_message_bytes: number;
  /** Directory for launch configs and per-connection state. */
  state_dir: string;
  dial?: DialSpec | null;
}

export const DEFAULTS: Omit<ProxyConfig, "agents" | "default_agent"> = {
  listen: { host: "127.0.0.1", port: 8000, path: "/acp" },
  tokens: [],
  allow_unauthenticated: false,
  idle_timeout_s: 600,
  replay_buffer: 20000,
  max_message_bytes: 32 * 1024 * 1024,
  state_dir: "/tmp/acp-web-proxy",
  dial: null,
};

function resolveEnv<T>(value: T, env: NodeJS.ProcessEnv): T {
  if (typeof value === "string") {
    if (value.startsWith("env:")) {
      const name = value.slice(4);
      return (env[name] ?? "") as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnv(v, env)) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnv(v, env)])) as T;
  }
  return value;
}

function asArgv(v: unknown, where: string): string[] {
  if (typeof v === "string") return v.split(/\s+/).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length > 0) return v as string[];
  throw new Error(`${where}: expected a command (string or non-empty string array)`);
}

function hook(v: unknown, where: string): HookSpec | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" || Array.isArray(v)) return { command: asArgv(v, where) };
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return { command: asArgv(o.command, `${where}.command`), timeout_s: typeof o.timeout_s === "number" ? o.timeout_s : undefined };
  }
  throw new Error(`${where}: invalid hook`);
}

export function normalizeConfig(raw: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const r = resolveEnv(raw, env);
  const agentsRaw = (r.agents ?? {}) as Record<string, Record<string, unknown>>;
  const agents: Record<string, AgentSpec> = {};
  for (const [name, a] of Object.entries(agentsRaw)) {
    const hooks = (a.hooks ?? {}) as Record<string, unknown>;
    agents[name] = {
      command: asArgv(a.command, `agents.${name}.command`),
      env: (a.env as Record<string, string>) ?? {},
      cwd: a.cwd as string | undefined,
      hooks: {
        prepare: hook(hooks.prepare, `agents.${name}.hooks.prepare`),
        after_prompt: hook(hooks.after_prompt, `agents.${name}.hooks.after_prompt`),
        shutdown: hook(hooks.shutdown, `agents.${name}.hooks.shutdown`),
      },
    };
  }
  const names = Object.keys(agents);
  if (names.length === 0) throw new Error("config: at least one agent is required under `agents`");
  const default_agent = (r.default_agent as string) ?? names[0];
  if (!agents[default_agent]) throw new Error(`config: default_agent '${default_agent}' is not defined`);

  const tokens = ([] as unknown[])
    .concat(r.tokens ?? [], r.token ?? [])
    .map(String)
    .filter((t) => t.length > 0);

  let listen = DEFAULTS.listen;
  if (r.listen === null || r.listen === false) listen = null;
  else if (r.listen && typeof r.listen === "object") listen = { ...DEFAULTS.listen!, ...(r.listen as object) };

  let dial: DialSpec | null = null;
  if (r.dial && typeof r.dial === "object") {
    const d = r.dial as Record<string, unknown>;
    if (!d.url || !d.runner_id) throw new Error("config: dial.url and dial.runner_id are required");
    dial = { url: String(d.url), token: d.token ? String(d.token) : undefined, runner_id: String(d.runner_id), labels: (d.labels as Record<string, string>) ?? {}, reconnect_s: typeof d.reconnect_s === "number" ? d.reconnect_s : 5 };
  }
  if (!listen && !dial) throw new Error("config: enable `listen`, `dial`, or both");

  const cfg: ProxyConfig = {
    ...DEFAULTS,
    listen,
    tokens,
    allow_unauthenticated: Boolean(r.allow_unauthenticated),
    agents,
    default_agent,
    idle_timeout_s: num(r.idle_timeout_s, DEFAULTS.idle_timeout_s),
    replay_buffer: num(r.replay_buffer, DEFAULTS.replay_buffer),
    max_message_bytes: num(r.max_message_bytes, DEFAULTS.max_message_bytes),
    state_dir: (r.state_dir as string) ?? DEFAULTS.state_dir,
    dial,
  };
  if (cfg.listen && cfg.tokens.length === 0 && !cfg.allow_unauthenticated) {
    throw new Error("config: listen mode needs `tokens` (or allow_unauthenticated: true for local development)");
  }
  return cfg;
}

function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const text = readFileSync(path, "utf8");
  const raw = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return normalizeConfig(raw ?? {}, env);
}
