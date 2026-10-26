/**
 * A logical connection: one agent process, and the frames it exchanges with
 * whichever WebSocket is currently attached.
 *
 * The connection outlives the socket. Every frame the proxy sends the client
 * gets a sequence number (1, 2, 3 … in send order) and is kept in a ring
 * buffer; a client that reconnects with `Acp-Connection-Id` and
 * `Acp-Last-Seq: N` gets every frame after N again, in order, before anything
 * new. Frames are relayed unmodified — the client only has to count them.
 *
 * Methods under `_proxy/` (ACP reserves the `_` prefix for extensions) are
 * answered by the proxy and never reach the agent:
 *
 *   _proxy/launch   {agent?, config?, env?} → {connection_id, agent, pid}
 *   _proxy/status   → {agent, pid, running, exit, stderr_tail}
 *   _proxy/shutdown → {} and the agent is stopped
 *
 * and the proxy may notify `_proxy/agent_exited` {code, signal, stderr_tail}.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSpec, ProxyConfig } from "./config.js";
import { AgentProcess } from "./agentProcess.js";
import { parsePrepareOutput, runHook } from "./hooks.js";
import type { Logger } from "./log.js";

export class ReplayGapError extends Error {}

type Sink = (frame: string, seq: number) => void;

interface JsonRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function idKey(id: unknown): string {
  return JSON.stringify(id);
}

export class Connection {
  readonly id: string;
  agentName: string | null = null;
  private agent: AgentProcess | null = null;
  private outbox: Array<{ seq: number; frame: string }> = [];
  private nextSeq = 0;
  private sink: Sink | null = null;
  private inbound: Promise<void> = Promise.resolve();
  private outbound: Promise<void> = Promise.resolve();
  /** client → agent requests awaiting a response: id → method */
  private pending = new Map<string, string>();
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private stateDir: string;
  private hookEnv: Record<string, string> = {};
  onClose: (() => void) | null = null;

  constructor(
    private cfg: ProxyConfig,
    private log: Logger,
    id?: string,
  ) {
    this.id = id ?? randomUUID();
    this.stateDir = join(cfg.state_dir, this.id);
  }

  get attached(): boolean {
    return this.sink !== null;
  }

  get lastSeq(): number {
    return this.nextSeq;
  }

  // ── socket attachment ────────────────────────────────────────────────────

  attach(sink: Sink, lastSeq = 0): void {
    if (this.closed) throw new Error("connection is closed");
    const oldest = this.outbox.length ? this.outbox[0].seq : this.nextSeq + 1;
    if (lastSeq < oldest - 1) {
      throw new ReplayGapError(`frames ${lastSeq + 1}..${oldest - 1} are no longer buffered`);
    }
    if (lastSeq > this.nextSeq) {
      throw new ReplayGapError(`client claims frame ${lastSeq}, proxy only sent ${this.nextSeq}`);
    }
    this.clearIdle();
    for (const item of this.outbox) if (item.seq > lastSeq) sink(item.frame, item.seq);
    this.sink = sink;
  }

  detach(sink: Sink): void {
    if (this.sink !== sink) return;
    this.sink = null;
    if (!this.closed) this.armIdle();
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.log.info("connection idle, shutting down", { connection: this.id });
      void this.shutdown("idle timeout");
    }, this.cfg.idle_timeout_s * 1000);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  // ── outbound (to client) ─────────────────────────────────────────────────

  /** Queue a frame to the client; order is preserved across held frames. */
  private emit(frame: string, before?: () => Promise<void>): void {
    this.outbound = this.outbound.then(async () => {
      if (before) await before();
      const seq = ++this.nextSeq;
      this.outbox.push({ seq, frame });
      if (this.outbox.length > this.cfg.replay_buffer) this.outbox.splice(0, this.outbox.length - this.cfg.replay_buffer);
      this.sink?.(frame, seq);
    }).catch((err) => this.log.error("emit failed", { connection: this.id, err: String(err) }));
  }

  private respond(id: JsonRpc["id"], result: unknown): void {
    this.emit(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private respondError(id: JsonRpc["id"], code: number, message: string, data?: unknown): void {
    this.emit(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } }));
  }

  private notify(method: string, params: unknown): void {
    this.emit(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Resolves once everything queued so far reached the outbox. */
  flushed(): Promise<void> {
    return this.outbound;
  }

  // ── inbound (from client) ────────────────────────────────────────────────

  handleClientFrame(text: string): void {
    // Serialised: a launch must finish before the frames behind it reach the agent.
    this.inbound = this.inbound.then(() => this.processClientFrame(text)).catch((err) => {
      this.log.error("client frame failed", { connection: this.id, err: String(err) });
    });
  }

  private async processClientFrame(text: string): Promise<void> {
    let msg: JsonRpc;
    try {
      msg = JSON.parse(text);
    } catch {
      this.respondError(null, -32700, "parse error");
      return;
    }
    if (typeof msg !== "object" || msg === null) {
      this.respondError(null, -32600, "invalid request");
      return;
    }
    if (typeof msg.method === "string" && msg.method.startsWith("_proxy/")) {
      await this.handleProxyMethod(msg);
      return;
    }
    if (!this.agent) {
      // A client that skips _proxy/launch gets the default agent, unconfigured.
      const err = await this.launch({});
      if (err) {
        if (msg.id !== undefined && msg.method) this.respondError(msg.id, -32603, err);
        return;
      }
    }
    if (this.agent?.exited) {
      if (msg.id !== undefined && msg.method) this.respondError(msg.id, -32603, "agent process has exited", this.exitInfo());
      return;
    }
    if (msg.method && msg.id !== undefined && msg.id !== null) this.pending.set(idKey(msg.id), msg.method);
    this.agent!.send(this.applyPolicy(msg) ?? text);
  }

  /** Create a session's working directory when it lies in the runner workspace. */
  private ensureWorkspace(msg: JsonRpc): void {
    const root = this.cfg.workspace_root;
    if (!root || (msg.method !== "session/new" && msg.method !== "session/load")) return;
    const cwd = (msg.params as { cwd?: unknown } | undefined)?.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return;
    const rel = relative(resolve(root), resolve(cwd));
    if (rel.startsWith("..") || isAbsolute(rel)) return;
    try {
      mkdirSync(cwd, { recursive: true });
    } catch (err) {
      this.log.warn("could not create session directory", { connection: this.id, cwd, err: String(err) });
    }
  }

  /** The frame to send instead of the client's, when policy changes it. */
  private applyPolicy(msg: JsonRpc): string | null {
    this.ensureWorkspace(msg);
    if (this.cfg.policy.allow_stdio_mcp) return null;
    if (msg.method !== "session/new" && msg.method !== "session/load") return null;
    const params = msg.params as { mcpServers?: Array<Record<string, unknown>> } | undefined;
    if (!Array.isArray(params?.mcpServers)) return null;
    // ACP: http/sse servers carry a `type`; stdio servers (a local command) do not.
    const isRemote = (s: Record<string, unknown>) => s.type === "http" || s.type === "sse";
    const dropped = params!.mcpServers.filter((s) => !isRemote(s)).map((s) => String(s.name ?? "?"));
    if (dropped.length === 0) return null;
    this.log.warn("policy: dropped stdio MCP servers", { connection: this.id, servers: dropped });
    return JSON.stringify({ ...msg, params: { ...params, mcpServers: params!.mcpServers.filter(isRemote) } });
  }

  private async handleProxyMethod(msg: JsonRpc): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (msg.method) {
      case "_proxy/launch": {
        if (this.agent && !this.agent.exited) {
          this.respondError(msg.id, -32600, "agent already launched on this connection");
          return;
        }
        const err = await this.launch(params);
        if (err) this.respondError(msg.id, -32603, err, { stderr_tail: this.agent?.stderrTail });
        else this.respond(msg.id, { connection_id: this.id, agent: this.agentName, pid: this.agent?.pid });
        return;
      }
      case "_proxy/status":
        this.respond(msg.id, {
          connection_id: this.id,
          agent: this.agentName,
          pid: this.agent?.pid ?? null,
          running: !!this.agent && !this.agent.exited,
          exit: this.agent?.exited ?? null,
          stderr_tail: this.agent?.stderrTail.slice(-8192) ?? "",
          last_seq: this.nextSeq,
        });
        return;
      case "_proxy/shutdown":
        this.respond(msg.id, {});
        await this.flushed();
        await this.shutdown("client request");
        return;
      default:
        if (msg.id !== undefined) this.respondError(msg.id, -32601, `unknown proxy method ${msg.method}`);
    }
  }

  // ── agent lifecycle ──────────────────────────────────────────────────────

  /** Start the agent; returns an error message or null. */
  private async launch(params: Record<string, unknown>): Promise<string | null> {
    const name = (params.agent as string | undefined) ?? this.cfg.default_agent;
    const spec: AgentSpec | undefined = this.cfg.agents[name];
    if (!spec) return `unknown agent '${name}' (available: ${Object.keys(this.cfg.agents).join(", ")})`;
    this.agentName = name;

    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const configFile = join(this.stateDir, "launch.json");
    const launchConfig = params.config ?? {};
    writeFileSync(configFile, JSON.stringify(launchConfig), { mode: 0o600 });

    const base = baseEnv();
    this.hookEnv = {
      ...base,
      ...(spec.env ?? {}),
      ACP_PROXY_CONNECTION_ID: this.id,
      ACP_PROXY_AGENT: name,
      ACP_PROXY_STATE_DIR: this.stateDir,
      ACP_PROXY_CONFIG_FILE: configFile,
    };
    let command = [...spec.command];
    let cwd = spec.cwd;
    let extraEnv: Record<string, string> = {};
    let callerEnv = (params.env as Record<string, string> | undefined) ?? {};
    if (!this.cfg.policy.allow_launch_env && Object.keys(callerEnv).length > 0) {
      this.log.warn("policy: ignored launch env", { connection: this.id, keys: Object.keys(callerEnv) });
      callerEnv = {};
    }

    if (spec.hooks?.prepare) {
      const res = await runHook(spec.hooks.prepare, JSON.stringify(launchConfig), { ...this.hookEnv, ...callerEnv }, cwd);
      if (res.code !== 0) {
        this.log.error("prepare hook failed", { connection: this.id, code: res.code, stderr: res.stderr.slice(-2000) });
        return `prepare hook failed (exit ${res.code}${res.timedOut ? ", timed out" : ""}): ${res.stderr.slice(-2000)}`;
      }
      try {
        const out = parsePrepareOutput(res.stdout);
        if (out.command?.length) command = out.command;
        if (out.args?.length) command = [...command, ...out.args];
        if (out.cwd) cwd = out.cwd;
        extraEnv = out.env ?? {};
      } catch (e) {
        return String((e as Error).message);
      }
    }

    const env = { ...this.hookEnv, ...callerEnv, ...extraEnv };
    this.log.info("launching agent", { connection: this.id, agent: name, command: command[0] });
    const agent = new AgentProcess({ command, env, cwd });
    this.agent = agent;
    agent.on("frame", (frame) => this.onAgentFrame(frame));
    agent.on("exit", (exit) => this.onAgentExit(exit));
    return null;
  }

  private onAgentFrame(frame: string): void {
    let msg: JsonRpc | null = null;
    try {
      msg = JSON.parse(frame);
    } catch {
      this.log.warn("agent wrote a non-JSON line", { connection: this.id, line: frame.slice(0, 200) });
      return;
    }
    const isResponse = msg && !msg.method && msg.id !== undefined && ("result" in msg || "error" in msg);
    if (isResponse) {
      const method = this.pending.get(idKey(msg!.id));
      this.pending.delete(idKey(msg!.id));
      const hook = this.agentName ? this.cfg.agents[this.agentName]?.hooks?.after_prompt : undefined;
      if (method === "session/prompt" && hook) {
        // Hold the end of the turn until the hook (e.g. workspace upload) is done.
        this.emit(frame, async () => {
          const res = await runHook(hook, frame, this.hookEnv);
          if (res.code !== 0) {
            this.log.error("after_prompt hook failed", { connection: this.id, code: res.code, stderr: res.stderr.slice(-2000) });
          }
        });
        return;
      }
    }
    this.emit(frame);
  }

  private exitInfo() {
    return { ...(this.agent?.exited ?? {}), stderr_tail: this.agent?.stderrTail.slice(-8192) ?? "" };
  }

  private onAgentExit(exit: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.log.info("agent exited", { connection: this.id, ...exit });
    // Fail every request the agent will now never answer.
    for (const [key, method] of this.pending) {
      this.respondError(JSON.parse(key), -32603, `agent exited before answering ${method}`, this.exitInfo());
    }
    this.pending.clear();
    this.notify("_proxy/agent_exited", this.exitInfo());
  }

  async shutdown(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    this.log.info("shutting down connection", { connection: this.id, reason });
    const spec = this.agentName ? this.cfg.agents[this.agentName] : undefined;
    if (this.agent) await this.agent.kill();
    if (spec?.hooks?.shutdown) {
      const res = await runHook(spec.hooks.shutdown, JSON.stringify({ reason }), this.hookEnv);
      if (res.code !== 0) this.log.error("shutdown hook failed", { connection: this.id, stderr: res.stderr.slice(-2000) });
    }
    try {
      rmSync(this.stateDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    this.onClose?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/** The proxy's own environment minus its secrets. */
function baseEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("ACP_PROXY_")) continue;
    out[k] = v;
  }
  return out;
}
