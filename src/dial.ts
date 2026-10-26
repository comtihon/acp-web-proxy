/**
 * Dial mode: for agents on machines the client cannot reach (a laptop behind
 * NAT, a VM without ingress). The proxy dials *out* to the client:
 *
 *   control socket  wss://<url>                      (Authorization: Bearer <token>)
 *     proxy → client  _proxy/register {runner_id, agents, default_agent, labels,
 *                       version, hostname, os, arch, tz}             → {runner_id, name}
 *     client → proxy  _proxy/open {connection_id?, last_seq?, resume?, url?} → {connection_id}
 *     client → proxy  _proxy/close {connection_id}                    → {}
 *     client → proxy  _proxy/ping                                      → {connections}
 *
 *   data socket     wss://<url>/connections/<connection_id>   (one per connection)
 *     identical to a listen-mode /acp socket: raw ACP frames both ways.
 *
 * The data plane is the same as listen mode, so the client speaks ACP the same
 * way to a pod it dialled and to a laptop that dialled it.
 *
 * The control socket reconnects with exponential backoff and jitter (so a
 * fleet of runners does not stampede a restarted client), and stops for good
 * when the client refuses the token (HTTP 401/403, close 4401/4403): the
 * runner was revoked and needs to enroll again.
 */

import { hostname } from "node:os";
import { WebSocket } from "ws";
import type { ProxyConfig } from "./config.js";
import { ConnectionRegistry, bindSocket } from "./server.js";
import type { Logger } from "./log.js";

export const VERSION = "0.2.0";

export const CLOSE_REVOKED = 4403;
export const CLOSE_UNAUTHORIZED = 4401;
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 60_000;

export type DialState = "connecting" | "connected" | "disconnected" | "revoked";

export interface DialOptions {
  /** Called on every state change of the control socket. */
  onState?: (state: DialState, info: { name?: string; error?: string }) => void;
}

export interface DialHandle {
  registry: ConnectionRegistry;
  close(): Promise<void>;
}

function dataUrl(base: string, connectionId: string): string {
  const u = new URL(base);
  u.pathname = u.pathname.replace(/\/+$/, "") + `/connections/${encodeURIComponent(connectionId)}`;
  return u.toString();
}

/** A client-supplied data URL must stay on the control socket's origin: the runner's token goes with it. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function backoffMs(attempt: number, baseS: number, maxS: number, random = Math.random): number {
  const ceiling = Math.min(maxS, baseS * 2 ** attempt) * 1000;
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export function registerParams(cfg: ProxyConfig): Record<string, unknown> {
  const dial = cfg.dial!;
  return {
    runner_id: dial.runner_id,
    agents: Object.keys(cfg.agents),
    default_agent: cfg.default_agent,
    labels: dial.labels ?? {},
    version: VERSION,
    hostname: hostname(),
    os: process.platform,
    arch: process.arch,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function startDial(cfg: ProxyConfig, log: Logger, registry = new ConnectionRegistry(cfg, log), opts: DialOptions = {}): DialHandle {
  const dial = cfg.dial;
  if (!dial) throw new Error("dial mode is disabled");
  const headers: Record<string, string> = {};
  if (dial.token) headers.authorization = `Bearer ${dial.token}`;
  const setState = (state: DialState, info: { name?: string; error?: string } = {}) => opts.onState?.(state, info);

  let stopped = false;
  let control: WebSocket | null = null;
  let retry: NodeJS.Timeout | null = null;
  let attempt = 0;

  const openData = (connectionId: string, lastSeq: number, url?: string) => {
    let conn = registry.get(connectionId);
    if (!conn) conn = registry.open(connectionId);
    const ws = new WebSocket(url ?? dataUrl(dial.url, connectionId), { headers, maxPayload: cfg.max_message_bytes });
    ws.once("open", () => {
      log.info("data socket open", { connection: connectionId, last_seq: lastSeq });
      bindSocket(ws, conn!, lastSeq, log);
    });
    ws.once("unexpected-response", (req, res) => {
      log.warn("data socket refused", { connection: connectionId, status: res.statusCode });
      res.resume();
      req.destroy();
    });
    ws.once("error", (err) => log.warn("data socket error", { connection: connectionId, err: String(err) }));
    return conn;
  };

  const revoke = (why: string) => {
    stopped = true;
    log.error("runner credential refused; enroll again", { reason: why });
    setState("revoked", { error: why });
  };

  const connect = () => {
    if (stopped) return;
    setState("connecting");
    const ws = new WebSocket(dial.url, { headers });
    control = ws;
    let reconnectScheduled = false;
    let alive = true;
    let pinger: NodeJS.Timeout | null = null;
    const scheduleReconnect = (why: string) => {
      if (reconnectScheduled) return;
      reconnectScheduled = true;
      if (pinger) clearInterval(pinger);
      if (control === ws) control = null;
      if (stopped) return;
      const delay = backoffMs(attempt++, dial.reconnect_s ?? 1, dial.reconnect_max_s ?? 60);
      log.warn("control socket down, reconnecting", { reason: why, in_ms: delay });
      setState("disconnected", { error: why });
      retry = setTimeout(connect, delay);
    };

    ws.on("unexpected-response", (req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      req.destroy();
      if (status === 401 || status === 403) revoke(`HTTP ${status}`);
      scheduleReconnect(`HTTP ${status}`);
    });
    ws.on("open", () => {
      log.info("control socket open", { url: dial.url, runner: dial.runner_id });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: "register", method: "_proxy/register", params: registerParams(cfg) }));
      pinger = setInterval(() => {
        if (!alive) {
          log.warn("control socket missed pongs, dropping it");
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, PING_INTERVAL_MS);
      pinger.unref();
    });
    ws.on("pong", () => { alive = true; });
    ws.on("ping", () => { alive = true; });
    ws.on("message", (data) => {
      alive = true;
      let msg: { id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.id === "register" && !msg.method) {
        if (msg.error) {
          log.error("registration refused", { error: msg.error.message });
          ws.close(1008, "registration refused");
          return;
        }
        attempt = 0;
        log.info("registered", { runner: dial.runner_id, name: msg.result?.name });
        setState("connected", { name: typeof msg.result?.name === "string" ? msg.result.name : undefined });
        return;
      }
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      const fail = (message: string) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message } }));
      if (msg.method === "_proxy/open") {
        const p = msg.params ?? {};
        const id = typeof p.connection_id === "string" && p.connection_id ? p.connection_id : undefined;
        const existing = id ? registry.get(id) : undefined;
        const lastSeq = Number(p.last_seq ?? 0) || 0;
        if (id && !existing && (p.resume === true || lastSeq > 0)) return fail(`unknown connection ${id}`);
        if (existing?.isClosed) return fail(`connection ${id} has ended`);
        const url = typeof p.url === "string" ? p.url : undefined;
        if (url && !sameOrigin(url, dial.url)) return fail("url must be on the control socket's origin");
        const conn = openData(id ?? cryptoId(), lastSeq, url);
        reply({ connection_id: conn.id });
      } else if (msg.method === "_proxy/close") {
        const conn = registry.get(String(msg.params?.connection_id ?? ""));
        void conn?.shutdown("client closed");
        reply({});
      } else if (msg.method === "_proxy/ping") {
        reply({ connections: registry.connections.size });
      } else if (msg.id !== undefined && msg.method) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } }));
      }
    });
    ws.on("close", (code, reason) => {
      if (code === CLOSE_REVOKED || code === CLOSE_UNAUTHORIZED) revoke(`closed ${code} ${reason.toString()}`.trim());
      scheduleReconnect(`closed ${code}`);
    });
    ws.on("error", (err) => log.warn("control socket error", { err: String(err) }));
  };
  connect();

  return {
    registry,
    close: async () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      control?.close();
      await registry.shutdownAll("runner stopping");
    },
  };
}

function cryptoId(): string {
  return globalThis.crypto.randomUUID();
}
