/**
 * Dial mode: for agents on machines the client cannot reach (a laptop behind
 * NAT, a VM without ingress). The proxy dials *out* to the client:
 *
 *   control socket  wss://<url>                      (Authorization: Bearer <token>)
 *     proxy → client  _proxy/register {runner_id, agents, labels, version}
 *     client → proxy  _proxy/open {connection_id?, last_seq?, url?}   → {connection_id}
 *     client → proxy  _proxy/close {connection_id}                    → {}
 *
 *   data socket     wss://<url>/connections/<connection_id>   (one per connection)
 *     identical to a listen-mode /acp socket: raw ACP frames both ways.
 *
 * The data plane is the same as listen mode, so the client speaks ACP the same
 * way to a pod it dialled and to a laptop that dialled it.
 */

import { WebSocket } from "ws";
import type { ProxyConfig } from "./config.js";
import { ConnectionRegistry, bindSocket } from "./server.js";
import type { Logger } from "./log.js";

export const VERSION = "0.1.0";

export interface DialHandle {
  registry: ConnectionRegistry;
  close(): Promise<void>;
}

function dataUrl(base: string, connectionId: string): string {
  const u = new URL(base);
  u.pathname = u.pathname.replace(/\/+$/, "") + `/connections/${encodeURIComponent(connectionId)}`;
  return u.toString();
}

export function startDial(cfg: ProxyConfig, log: Logger, registry = new ConnectionRegistry(cfg, log)): DialHandle {
  const dial = cfg.dial;
  if (!dial) throw new Error("dial mode is disabled");
  const headers: Record<string, string> = {};
  if (dial.token) headers.authorization = `Bearer ${dial.token}`;

  let stopped = false;
  let control: WebSocket | null = null;
  let retry: NodeJS.Timeout | null = null;

  const openData = (connectionId: string, lastSeq: number, url?: string) => {
    let conn = registry.get(connectionId);
    if (!conn) conn = registry.open(connectionId);
    const ws = new WebSocket(url ?? dataUrl(dial.url, connectionId), { headers, maxPayload: cfg.max_message_bytes });
    ws.once("open", () => {
      log.info("data socket open", { connection: connectionId, last_seq: lastSeq });
      bindSocket(ws, conn!, lastSeq, log);
    });
    ws.once("error", (err) => log.warn("data socket error", { connection: connectionId, err: String(err) }));
    return conn;
  };

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(dial.url, { headers });
    control = ws;
    ws.on("open", () => {
      log.info("control socket open", { url: dial.url, runner: dial.runner_id });
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "_proxy/register",
        params: { runner_id: dial.runner_id, agents: Object.keys(cfg.agents), default_agent: cfg.default_agent, labels: dial.labels ?? {}, version: VERSION },
      }));
    });
    ws.on("message", (data) => {
      let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      const fail = (message: string) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message } }));
      if (msg.method === "_proxy/open") {
        const p = msg.params ?? {};
        const id = typeof p.connection_id === "string" && p.connection_id ? p.connection_id : undefined;
        const existing = id ? registry.get(id) : undefined;
        if (id && !existing && Number(p.last_seq ?? 0) > 0) return fail(`unknown connection ${id}`);
        const conn = openData(id ?? cryptoId(), Number(p.last_seq ?? 0) || 0, typeof p.url === "string" ? p.url : undefined);
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
    ws.on("close", (code) => {
      control = null;
      if (stopped) return;
      log.warn("control socket closed, reconnecting", { code, in_s: dial.reconnect_s });
      retry = setTimeout(connect, (dial.reconnect_s ?? 5) * 1000);
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
