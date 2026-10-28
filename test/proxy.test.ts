import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { normalizeConfig, type ProxyConfig } from "../src/config.js";
import { startServer, type ListenHandle } from "../src/server.js";
import { startDial } from "../src/dial.js";
import { silentLogger } from "../src/log.js";

const FAKE = resolve(__dirname, "fixtures/fake-agent.mjs");
const TOKEN = "s3cret";

let handles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(handles.map((h) => h.close()));
  handles = [];
});

function cfg(over: Record<string, unknown> = {}, agentOver: Record<string, unknown> = {}): ProxyConfig {
  const dir = mkdtempSync(join(tmpdir(), "acpwp-"));
  return normalizeConfig({
    listen: { host: "127.0.0.1", port: 0, path: "/acp" },
    tokens: [TOKEN],
    state_dir: dir,
    agents: { fake: { command: [process.execPath, FAKE], ...agentOver } },
    ...over,
  });
}

async function serve(c: ProxyConfig): Promise<ListenHandle> {
  const h = await startServer(c, silentLogger);
  handles.push(h);
  return h;
}

class Client {
  frames: any[] = [];
  connectionId = "";
  private waiters: Array<() => void> = [];
  closeCode: number | null = null;
  constructor(public ws: WebSocket) {
    ws.on("message", (d) => {
      this.frames.push(JSON.parse(d.toString()));
      this.waiters.splice(0).forEach((w) => w());
    });
    ws.on("close", (code) => {
      this.closeCode = code;
      this.waiters.splice(0).forEach((w) => w());
    });
  }
  static open(port: number, headers: Record<string, string> = {}): Promise<Client> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`, { headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
      const c = new Client(ws);
      ws.on("upgrade", (r) => { c.connectionId = String(r.headers["acp-connection-id"] ?? ""); });
      ws.once("open", () => res(c));
      ws.once("unexpected-response", (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
      ws.once("error", rej);
    });
  }
  send(obj: unknown) { this.ws.send(JSON.stringify(obj)); }
  async until(pred: (f: any[]) => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!pred(this.frames)) {
      if (this.closeCode !== null) throw new Error(`socket closed (${this.closeCode})`);
      if (Date.now() > end) throw new Error("timeout; frames=" + JSON.stringify(this.frames).slice(0, 500));
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50); });
    }
  }
  response(id: number) { return this.frames.find((f) => f.id === id && !f.method); }
  async call(id: number, method: string, params: unknown = {}) {
    this.send({ jsonrpc: "2.0", id, method, params });
    await this.until(() => !!this.response(id));
    return this.response(id);
  }
  close() { this.ws.close(); }
}

const prompt = (text: string) => ({ sessionId: "s1", prompt: [{ type: "text", text }] });

describe("listen mode", () => {
  it("rejects a missing or wrong token", async () => {
    const h = await serve(cfg());
    await expect(Client.open(h.port, { authorization: "Bearer nope" })).rejects.toThrow(/401/);
  });

  it("serves /health", async () => {
    const h = await serve(cfg());
    const res = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(await res.json()).toMatchObject({ ok: true, agents: ["fake"] });
  });

  it("launches through the prepare hook and relays a full turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpwp-hook-"));
    const hook = join(dir, "prepare.mjs");
    writeFileSync(hook, `
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        const cfg=JSON.parse(s);
        console.log("log line before json");
        console.log(JSON.stringify({env:{FAKE_MARK: cfg.mark + ":" + process.env.ACP_PROXY_AGENT}, cwd: ${JSON.stringify(dir)}}));
      });`);
    const h = await serve(cfg({}, { hooks: { prepare: [process.execPath, hook] } }));
    const c = await Client.open(h.port);
    expect(c.connectionId).toMatch(/[0-9a-f-]{36}/);
    const launched = await c.call(1, "_proxy/launch", { agent: "fake", config: { mark: "hello" } });
    expect(launched.result).toMatchObject({ connection_id: c.connectionId, agent: "fake" });
    const init = await c.call(2, "initialize", { protocolVersion: 1 });
    expect(init.result.agentInfo).toMatchObject({ env: "hello:fake", cwd: dir });
    await c.call(3, "session/new", { cwd: "/tmp", mcpServers: [] });
    const done = await c.call(4, "session/prompt", prompt("chunks=2"));
    expect(done.result.stopReason).toBe("end_turn");
    const chunks = c.frames.filter((f) => f.method === "session/update").map((f) => f.params.update.content.text);
    expect(chunks).toEqual(["c0", "c1"]);
    c.close();
  });

  it("auto-launches the default agent when the client starts with initialize", async () => {
    const h = await serve(cfg());
    const c = await Client.open(h.port);
    const init = await c.call(1, "initialize", {});
    expect(init.result.agentInfo.name).toBe("fake");
  });

  it("relays agent → client requests (permission) and their answers", async () => {
    const h = await serve(cfg());
    const c = await Client.open(h.port);
    await c.call(1, "initialize", {});
    c.send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: prompt("chunks=0 ask") });
    await c.until((f) => f.some((x) => x.method === "session/request_permission"));
    const req = c.frames.find((x) => x.method === "session/request_permission");
    c.send({ jsonrpc: "2.0", id: req.id, result: { outcome: { outcome: "selected", optionId: "ok" } } });
    await c.until(() => !!c.response(2));
    expect(c.frames.some((f) => f.params?.update?.content?.text === "perm:ok")).toBe(true);
  });

  it("replays frames a client missed after reconnecting", async () => {
    const h = await serve(cfg());
    const a = await Client.open(h.port);
    await a.call(1, "initialize", {});
    const seen = a.frames.length; // 1
    a.close();
    await new Promise((r) => setTimeout(r, 50));
    // While nobody is attached the turn runs on: its frames are buffered.
    const conn = h.registry.get(a.connectionId)!;
    conn.handleClientFrame(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: prompt("chunks=3") }));
    await new Promise((r) => setTimeout(r, 300));
    const b = await Client.open(h.port, { "acp-connection-id": a.connectionId, "acp-last-seq": String(seen) });
    await b.until(() => !!b.response(2));
    const texts = b.frames.filter((f) => f.method === "session/update").map((f) => f.params.update.content.text);
    expect(texts).toEqual(["c0", "c1", "c2"]);
    expect(b.frames.find((f) => f.id === 1)).toBeUndefined(); // already seen, not replayed
  });

  it("refuses to resume past the replay buffer", async () => {
    const h = await serve(cfg({ replay_buffer: 2 }));
    const a = await Client.open(h.port);
    await a.call(1, "initialize", {});
    await a.call(2, "session/prompt", prompt("chunks=5"));
    a.close();
    await new Promise((r) => setTimeout(r, 50));
    const b = await Client.open(h.port, { "acp-connection-id": a.connectionId, "acp-last-seq": "1" });
    await new Promise((r) => setTimeout(r, 200));
    expect(b.closeCode).toBe(4409);
  });

  it("rejects an unknown connection id", async () => {
    const h = await serve(cfg());
    await expect(Client.open(h.port, { "acp-connection-id": "nope" })).rejects.toThrow(/404/);
  });

  it("holds the end of a turn until after_prompt finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpwp-ap-"));
    const marker = join(dir, "uploaded");
    const hook = join(dir, "after.mjs");
    writeFileSync(hook, `import fs from "node:fs"; await new Promise(r=>setTimeout(r,200)); fs.writeFileSync(${JSON.stringify(marker)}, process.env.ACP_PROXY_CONNECTION_ID);`);
    const h = await serve(cfg({}, { hooks: { after_prompt: [process.execPath, hook] } }));
    const c = await Client.open(h.port);
    await c.call(1, "initialize", {});
    await c.call(2, "session/prompt", prompt("chunks=1"));
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe(c.connectionId);
  });

  it("fails pending requests and notifies when the agent dies", async () => {
    const h = await serve(cfg());
    const c = await Client.open(h.port);
    await c.call(1, "initialize", {});
    const res = await c.call(2, "session/prompt", prompt("chunks=0 crash"));
    expect(res.error.message).toMatch(/agent exited/);
    await c.until((f) => f.some((x) => x.method === "_proxy/agent_exited"));
    expect(c.frames.find((x) => x.method === "_proxy/agent_exited").params.code).toBe(3);
    const after = await c.call(3, "session/new", {});
    expect(after.error.message).toMatch(/exited/);
  });

  it("reports a failing prepare hook to the launch call", async () => {
    const h = await serve(cfg({}, { hooks: { prepare: [process.execPath, "-e", "console.error('no creds'); process.exit(7)"] } }));
    const c = await Client.open(h.port);
    const res = await c.call(1, "_proxy/launch", {});
    expect(res.error.message).toMatch(/exit 7.*no creds/s);
  });

  it("shuts the agent down after the idle timeout", async () => {
    const h = await serve(cfg({ idle_timeout_s: 0.2 }));
    const c = await Client.open(h.port);
    await c.call(1, "initialize", {});
    const id = c.connectionId;
    c.close();
    await new Promise((r) => setTimeout(r, 600));
    expect(h.registry.get(id)).toBeUndefined();
  });

  it("answers _proxy/status and _proxy/shutdown", async () => {
    const h = await serve(cfg());
    const c = await Client.open(h.port);
    await c.call(1, "initialize", {});
    const st = await c.call(2, "_proxy/status");
    expect(st.result).toMatchObject({ agent: "fake", running: true });
    await c.call(3, "_proxy/shutdown");
    await c.until(() => c.closeCode !== null).catch(() => {});
    expect(h.registry.get(c.connectionId)).toBeUndefined();
  });
});

describe("dial mode", () => {
  it("registers, opens a data connection on request, and relays ACP", async () => {
    const wss = new WebSocketServer({ port: 0 });
    handles.push({ close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }) });
    const port = (wss.address() as { port: number }).port;
    const registered: any[] = [];
    const data = new Promise<WebSocket>((resolveData) => {
      wss.on("connection", (ws, req) => {
        expect(req.headers.authorization).toBe("Bearer dial-token");
        if (req.url?.includes("/connections/")) {
          resolveData(ws);
          return;
        }
        ws.on("message", (d) => {
          const msg = JSON.parse(d.toString());
          if (msg.method === "_proxy/register") {
            registered.push(msg.params);
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_proxy/open", params: { connection_id: "c-123" } }));
          }
        });
      });
    });
    const c = cfg({ listen: null, tokens: [], dial: { url: `ws://127.0.0.1:${port}/runners/connect`, token: "dial-token", runner_id: "laptop" } });
    const h = startDial(c, silentLogger);
    handles.push(h);
    const ws = await data;
    const client = new Client(ws);
    client.send({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
    await client.until(() => !!client.response(7));
    expect(registered[0]).toMatchObject({ runner_id: "laptop", agents: ["fake"] });
    expect(h.registry.get("c-123")).toBeTruthy();
  });
});

describe("config", () => {
  it("resolves env: references and requires auth in listen mode", () => {
    const c = normalizeConfig({ tokens: ["env:T"], agents: { a: { command: "x --y" } } }, { T: "abc" });
    expect(c.tokens).toEqual(["abc"]);
    expect(c.agents.a.command).toEqual(["x", "--y"]);
    expect(() => normalizeConfig({ agents: { a: { command: "x" } } }, {})).toThrow(/tokens/);
    expect(() => normalizeConfig({ tokens: ["t"], agents: {} }, {})).toThrow(/at least one agent/);
  });
});

describe("workspace sync", () => {
  /** An object store stand-in: GET /ws serves `archive` (404 when unset), PUT /ws stores the body. */
  async function store(archive: Buffer | null) {
    const state = { archive, gets: 0, puts: [] as Array<{ body: Buffer; type: string | undefined; mark: string | undefined }> };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c)).on("end", () => {
        if (req.method === "GET") {
          state.gets++;
          if (!state.archive) return res.writeHead(404).end("NoSuchKey");
          return res.writeHead(200).end(state.archive);
        }
        state.puts.push({ body: Buffer.concat(chunks), type: req.headers["content-type"], mark: req.headers["x-mark"] as string | undefined });
        state.archive = Buffer.concat(chunks);
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    handles.push({ close: () => new Promise<void>((r) => server.close(() => r())) });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    return { state, url };
  }

  function tarOf(files: Record<string, string>): Buffer {
    const src = mkdtempSync(join(tmpdir(), "acpwp-src-"));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(src, name), body);
    const out = join(mkdtempSync(join(tmpdir(), "acpwp-tar-")), "a.tar.gz");
    execFileSync("tar", ["-czf", out, "-C", src, "."]);
    return readFileSync(out);
  }

  function untar(archive: Buffer): string {
    const dir = mkdtempSync(join(tmpdir(), "acpwp-out-"));
    const file = join(dir, "..", `${dir.split(/[\\/]/).pop()}.tar.gz`);
    writeFileSync(file, archive);
    execFileSync("tar", ["-xzf", file, "-C", dir]);
    return dir;
  }

  it("restores the directory before launch and uploads it after every turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "acpwp-root-"));
    const dir = join(root, "run-1");
    const { state, url } = await store(tarOf({ "model.obj": "v 0 0 0", "skip.jpg": "photo" }));
    const h = await serve(cfg({ workspace_root: root }));
    const c = await Client.open(h.port);
    const launched = await c.call(1, "_proxy/launch", {
      config: { workspace: { dir, download_url: url, upload_url: url, upload_headers: { "x-mark": "signed" }, exclude: ["*.jpg"] } },
    });
    expect(launched.result.workspace).toEqual({ dir, restore: "restored" });
    expect(readFileSync(join(dir, "model.obj"), "utf8")).toBe("v 0 0 0");

    writeFileSync(join(dir, "simplified.obj"), "v 1 1 1");
    await c.call(2, "initialize", {});
    await c.call(3, "session/prompt", prompt("chunks=1"));
    const iNote = c.frames.findIndex((f) => f.method === "_proxy/workspace");
    const iDone = c.frames.findIndex((f) => f.id === 3 && !f.method);
    expect(iNote).toBeGreaterThanOrEqual(0);
    expect(iNote).toBeLessThan(iDone);
    expect(c.frames[iNote].params).toMatchObject({ event: "uploaded", dir });
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0]).toMatchObject({ type: "application/gzip", mark: "signed" });
    const out = untar(state.puts[0].body);
    expect(readFileSync(join(out, "simplified.obj"), "utf8")).toBe("v 1 1 1");
    expect(existsSync(join(out, "skip.jpg"))).toBe(false);
  });

  it("starts empty when nothing was uploaded yet, and keeps a directory that has work in it", async () => {
    const root = mkdtempSync(join(tmpdir(), "acpwp-root-"));
    const dir = join(root, "run-2");
    const { state, url } = await store(null);
    const h = await serve(cfg({ workspace_root: root }));
    const c1 = await Client.open(h.port);
    expect((await c1.call(1, "_proxy/launch", { config: { workspace: { dir, download_url: url } } })).result.workspace.restore).toBe("empty");
    expect(existsSync(dir)).toBe(true);

    writeFileSync(join(dir, "local.txt"), "newer than the store");
    state.archive = tarOf({ "local.txt": "older" });
    const c2 = await Client.open(h.port);
    expect((await c2.call(1, "_proxy/launch", { config: { workspace: { dir, download_url: url } } })).result.workspace.restore).toBe("kept");
    expect(readFileSync(join(dir, "local.txt"), "utf8")).toBe("newer than the store");
    expect(state.gets).toBe(1);
  });

  it("reports a failed upload without failing the turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "acpwp-root-"));
    const h = await serve(cfg({ workspace_root: root }));
    const c = await Client.open(h.port);
    await c.call(1, "_proxy/launch", { config: { workspace: { dir: join(root, "r"), upload_url: "http://127.0.0.1:1/nowhere" } } });
    await c.call(2, "initialize", {});
    const done = await c.call(3, "session/prompt", prompt("chunks=1"));
    expect(done.result.stopReason).toBe("end_turn");
    expect(c.frames.find((f) => f.method === "_proxy/workspace")?.params.event).toBe("upload_failed");
  });

  it("refuses a directory outside the workspace root, or no root at all", async () => {
    const root = mkdtempSync(join(tmpdir(), "acpwp-root-"));
    const h = await serve(cfg({ workspace_root: root }));
    const c = await Client.open(h.port);
    const outside = await c.call(1, "_proxy/launch", { config: { workspace: { dir: join(root, "..", "elsewhere") } } });
    expect(outside.error.message).toMatch(/inside/);
    const h2 = await serve(cfg());
    const c2 = await Client.open(h2.port);
    const noRoot = await c2.call(1, "_proxy/launch", { config: { workspace: { dir: join(root, "x") } } });
    expect(noRoot.error.message).toMatch(/workspace_root/);
  });
});
