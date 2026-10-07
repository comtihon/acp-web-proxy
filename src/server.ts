/**
 * Listen mode: HTTP server with /health and a WebSocket endpoint (default /acp).
 *
 * Handshake (shaped after ACP's draft Streamable HTTP & WebSocket transport):
 *
 *   GET /acp  Upgrade: websocket
 *     Authorization: Bearer <token>
 *     Acp-Connection-Id: <id>     (optional) re-attach to an existing connection
 *     Acp-Last-Seq: <n>           (optional) frames already received on it
 *     Acp-Agent: <name>           (optional) default agent for auto-launch
 *
 *   101 Switching Protocols
 *     Acp-Connection-Id: <id>
 *
 * After that, each WebSocket text message is one JSON-RPC frame in either
 * direction.
 */

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { ProxyConfig } from "./config.js";
import { Connection, ReplayGapError } from "./connection.js";
import type { Logger } from "./log.js";

export const CLOSE_REPLAY_GAP = 4409;
export const CLOSE_UNKNOWN_CONNECTION = 4404;
export const CLOSE_SUPERSEDED = 4000;
export const CLOSE_CONNECTION_ENDED = 4001;

export function tokenOk(header: string | undefined, tokens: string[]): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const given = Buffer.from(m[1]);
  return tokens.some((t) => {
    const want = Buffer.from(t);
    return want.length === given.length && timingSafeEqual(want, given);
  });
}

export class ConnectionRegistry {
  readonly connections = new Map<string, Connection>();
  constructor(private cfg: ProxyConfig, private log: Logger) {}

  open(id?: string): Connection {
    const conn = new Connection(this.cfg, this.log, id);
    this.connections.set(conn.id, conn);
    conn.onClose = () => this.connections.delete(conn.id);
    return conn;
  }

  get(id: string): Connection | undefined {
    return this.connections.get(id);
  }

  async shutdownAll(reason: string): Promise<void> {
    await Promise.all([...this.connections.values()].map((c) => c.shutdown(reason)));
  }
}

/**
 * Bind a WebSocket to a connection: relay frames both ways, replay what the
 * client missed, detach (not close) the connection when the socket goes.
 */
export function bindSocket(ws: WebSocket, conn: Connection, lastSeq: number, log: Logger): void {
  const sink = (frame: string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  };
  try {
    conn.attach(sink, lastSeq);
  } catch (err) {
    const code = err instanceof ReplayGapError ? CLOSE_REPLAY_GAP : 1011;
    ws.close(code, String((err as Error).message).slice(0, 120));
    return;
  }
  const previousOnClose = conn.onClose;
  const closeSocketWhenConnectionEnds = () => {
    previousOnClose?.();
    if (ws.readyState === WebSocket.OPEN) ws.close(CLOSE_CONNECTION_ENDED, "connection ended");
  };
  conn.onClose = closeSocketWhenConnectionEnds;

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      ws.close(1003, "text frames only");
      return;
    }
    conn.handleClientFrame(data.toString());
  });
  ws.on("close", () => {
    conn.detach(sink);
    if (conn.onClose === closeSocketWhenConnectionEnds) conn.onClose = previousOnClose;
    log.debug("socket detached", { connection: conn.id });
  });
  ws.on("error", (err) => log.warn("socket error", { connection: conn.id, err: String(err) }));
}

export interface ListenHandle {
  server: http.Server;
  registry: ConnectionRegistry;
  port: number;
  close(): Promise<void>;
}

export function startServer(cfg: ProxyConfig, log: Logger, registry = new ConnectionRegistry(cfg, log)): Promise<ListenHandle> {
  if (!cfg.listen) throw new Error("listen mode is disabled");
  const { host, port, path } = cfg.listen;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, agents: Object.keys(cfg.agents), connections: registry.connections.size }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.max_message_bytes });
  // Tell the client which connection it got, on the 101 response itself.
  const pendingIds = new WeakMap<http.IncomingMessage, string>();
  wss.on("headers", (headers, req) => {
    const id = pendingIds.get(req);
    if (id) headers.push(`Acp-Connection-Id: ${id}`);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const reject = (status: number, msg: string) => {
      socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== path) return reject(404, "Not Found");
    if (!cfg.allow_unauthenticated && !tokenOk(req.headers.authorization, cfg.tokens)) {
      log.warn("rejected unauthenticated upgrade", { remote: req.socket.remoteAddress });
      return reject(401, "Unauthorized");
    }
    const wantedId = header(req, "acp-connection-id");
    const lastSeq = Number(header(req, "acp-last-seq") ?? "0") || 0;
    let conn: Connection | undefined;
    if (wantedId) {
      conn = registry.get(wantedId);
      if (!conn || conn.isClosed) return reject(404, "Unknown Connection");
    } else {
      conn = registry.open();
    }
    pendingIds.set(req, conn.id);
    wss.handleUpgrade(req, socket, head, (ws) => {
      log.info("socket attached", { connection: conn!.id, resumed: !!wantedId, last_seq: lastSeq });
      bindSocket(ws, conn!, lastSeq, log);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      log.info("listening", { host, port: actual, path });
      resolve({
        server,
        registry,
        port: actual,
        close: async () => {
          for (const client of wss.clients) client.terminate();
          await registry.shutdownAll("server stopping");
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
