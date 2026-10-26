import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { normalizeConfig, type ProxyConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import { backoffMs, sameOrigin, startDial, type DialState } from "../src/dial.js";
import { resolveSpawn } from "../src/spawnCommand.js";
import { connectUrl, createEnrollment, discoverCarrier, normalizeUrl, pollEnrollment } from "../src/enroll.js";
import { Home } from "../src/home.js";
import { launchdPlist, systemdUnit, windowsLauncher } from "../src/service.js";
import { parseArgs } from "../src/cli.js";
import { silentLogger } from "../src/log.js";

const FAKE = resolve(__dirname, "fixtures/fake-agent.mjs");
const CLI = resolve(__dirname, "../dist/cli.js");

let closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

function cfg(over: Record<string, unknown> = {}): ProxyConfig {
  const dir = mkdtempSync(join(tmpdir(), "acpwp-"));
  return normalizeConfig({
    listen: null,
    state_dir: dir,
    agents: { fake: { command: [process.execPath, FAKE] } },
    ...over,
  });
}

const until = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A fake carrier control endpoint. */
async function fakeCarrier(onConnection: (ws: WebSocket, req: http.IncomingMessage) => void, verify?: (req: http.IncomingMessage) => number) {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const status = verify?.(req) ?? 101;
    if (status !== 101) {
      socket.write(`HTTP/1.1 ${status} No\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => r()); }));
  return { port: () => (server.address() as { port: number }).port, server };
}

describe("spawn on Windows", () => {
  it("runs .cmd shims through cmd.exe with escaped arguments", () => {
    const dir = mkdtempSync(join(tmpdir(), "acpwp-bin-"));
    writeFileSync(join(dir, "npx.cmd"), "@echo off");
    const r = resolveSpawn(["npx", "-y", "@scope/pkg", "a b&c"], { PATH: dir, PATHEXT: ".EXE;.CMD", comspec: "C:\\cmd.exe" }, "win32");
    expect(r.file).toBe("C:\\cmd.exe");
    expect(r.windowsVerbatimArguments).toBe(true);
    expect(r.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(r.args[3]).toContain("npx.cmd");
    expect(r.args[3]).toContain('^"a^ b^&c^"');
  });

  it("spawns real executables directly and leaves other platforms alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "acpwp-bin-"));
    writeFileSync(join(dir, "codex-acp.exe"), "");
    const r = resolveSpawn(["codex-acp"], { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32");
    expect(r.file).toBe(join(dir, "codex-acp.exe"));
    expect(resolveSpawn(["npx", "-y"], {}, "linux")).toEqual({ file: "npx", args: ["-y"] });
  });
});

describe("dial hardening", () => {
  it("backs off exponentially with jitter, capped", () => {
    expect(backoffMs(0, 1, 60, () => 0)).toBe(500);
    expect(backoffMs(0, 1, 60, () => 1)).toBe(1000);
    expect(backoffMs(3, 1, 60, () => 1)).toBe(8000);
    expect(backoffMs(20, 1, 60, () => 1)).toBe(60000);
  });

  it("only accepts data URLs on the control socket's origin", () => {
    expect(sameOrigin("wss://c.example/x/connections/1", "wss://c.example/api/connect")).toBe(true);
    expect(sameOrigin("wss://evil.example/x", "wss://c.example/api/connect")).toBe(false);
  });

  it("registers with machine details, reports connected, and refuses foreign urls and unknown resumes", async () => {
    const replies: any[] = [];
    let registered: any = null;
    const carrier = await fakeCarrier((ws, req) => {
      if (req.url?.includes("/connections/")) return;
      ws.on("message", (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.method === "_proxy/register") {
          registered = msg.params;
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { runner_id: "r1", name: "laptop" } }));
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_proxy/open", params: { connection_id: "c1", url: "ws://evil.example/x" } }));
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "_proxy/open", params: { connection_id: "c2", resume: true } }));
        } else replies.push(msg);
      });
    });
    const states: Array<[DialState, string | undefined]> = [];
    const h = startDial(cfg({ dial: { url: `ws://127.0.0.1:${carrier.port()}/connect`, token: "t", runner_id: "r1" } }), silentLogger, undefined, {
      onState: (s, i) => states.push([s, i.name]),
    });
    closers.push(h.close);
    await until(() => replies.length === 2);
    expect(registered).toMatchObject({ runner_id: "r1", agents: ["fake"], os: process.platform });
    expect(typeof registered.tz).toBe("string");
    expect(states).toContainEqual(["connected", "laptop"]);
    expect(replies.find((r) => r.id === 1).error.message).toMatch(/origin/);
    expect(replies.find((r) => r.id === 2).error.message).toMatch(/unknown connection/);
  });

  it("stops reconnecting once carrier refuses the token", async () => {
    let attempts = 0;
    const carrier = await fakeCarrier(() => {}, () => { attempts++; return 403; });
    const states: DialState[] = [];
    const h = startDial(cfg({ dial: { url: `ws://127.0.0.1:${carrier.port()}/connect`, token: "t", runner_id: "r1", reconnect_s: 0.01 } }), silentLogger, undefined, {
      onState: (s) => states.push(s),
    });
    closers.push(h.close);
    await until(() => states.includes("revoked"));
    await new Promise((r) => setTimeout(r, 200));
    expect(attempts).toBe(1);
  });

  it("treats close code 4403 as revoked", async () => {
    const carrier = await fakeCarrier((ws) => ws.close(4403, "revoked"));
    const states: DialState[] = [];
    const h = startDial(cfg({ dial: { url: `ws://127.0.0.1:${carrier.port()}/connect`, token: "t", runner_id: "r1", reconnect_s: 0.01 } }), silentLogger, undefined, {
      onState: (s) => states.push(s),
    });
    closers.push(h.close);
    await until(() => states.includes("revoked"));
  });
});

describe("local policy", () => {
  it("drops stdio MCP servers and launch env when turned off", async () => {
    const c = normalizeConfig({
      listen: { host: "127.0.0.1", port: 0, path: "/acp" },
      tokens: ["tok"],
      state_dir: mkdtempSync(join(tmpdir(), "acpwp-")),
      agents: { fake: { command: [process.execPath, FAKE] } },
      policy: { allow_launch_env: false, allow_stdio_mcp: false },
    });
    const h = await startServer(c, silentLogger);
    closers.push(h.close);
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/acp`, { headers: { authorization: "Bearer tok" } });
    const frames: any[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once("open", r));
    const call = async (id: number, method: string, params: unknown) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      await until(() => frames.some((f) => f.id === id));
      return frames.find((f) => f.id === id);
    };
    await call(1, "_proxy/launch", { env: { FAKE_MARK: "injected" } });
    const init = await call(2, "initialize", {});
    expect(init.result.agentInfo.env).toBeNull();
    const created = await call(3, "session/new", {
      cwd: "/",
      mcpServers: [
        { name: "local", command: "rm", args: ["-rf", "/"], env: [] },
        { type: "http", name: "remote", url: "https://x", headers: [] },
      ],
    });
    expect(created.result._meta.mcpServers).toEqual(["remote"]);
    ws.close();
  });
});

describe("enrollment client", () => {
  const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("normalizes URLs and builds the connect URL", () => {
    expect(normalizeUrl("carrier.example.com/#x")).toBe("https://carrier.example.com");
    expect(connectUrl("https://c.example")).toBe("wss://c.example/api/v1/acp/runners/connect");
    expect(connectUrl("http://localhost:8000")).toBe("ws://localhost:8000/api/v1/acp/runners/connect");
  });

  it("finds the API directly or through the UI's config.js", async () => {
    const f = (async (url: string) => {
      if (url === "https://api.example/api/v1/acp/runners/info") return jsonRes({ runners: true, ui_url: "https://ui.example/" });
      if (url === "https://ui.example/config.js") return new Response('window.runtimeConfig = { BACKEND_URL: "https://api.example", X: 1 };');
      return new Response("", { status: 404 });
    }) as typeof fetch;
    expect(await discoverCarrier("https://api.example", f)).toEqual({ api: "https://api.example", ui: "https://ui.example" });
    expect(await discoverCarrier("ui.example", f)).toEqual({ api: "https://api.example", ui: "https://ui.example" });
    await expect(discoverCarrier("https://nothing.example", f)).rejects.toThrow(/does not look like carrier/);
  });

  it("creates an enrollment and maps poll answers", async () => {
    let body: any = null;
    const f = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/enrollments")) {
        body = JSON.parse(String(init!.body));
        return jsonRes({ enrollment_id: "e1", poll_token: "pt", code: "482913", expires_at: "2030-01-01T00:00:00Z", interval_s: 3, approve_url: null }, 201);
      }
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer pt");
      return jsonRes({ status: "approved", runner_id: "r1", runner_name: "lap", token: "r1.sec" });
    }) as typeof fetch;
    const e = await createEnrollment({ api: "https://c", ui: "https://ui" }, { hostname: "h", os: "linux", arch: "x64", tz: "UTC", version: "1", agents: ["claude"], default_agent: "claude" }, f);
    expect(body.agents).toEqual(["claude"]);
    expect(e).toMatchObject({ enrollment_id: "e1", code: "482913", interval_s: 3, approve_url: "https://ui/#approve-runner" });
    expect(await pollEnrollment(e, f)).toEqual({ status: "approved", runner_id: "r1", runner_name: "lap", token: "r1.sec" });
    expect(await pollEnrollment(e, (async () => new Response("", { status: 410 })) as typeof fetch)).toEqual({ status: "expired" });
    expect(await pollEnrollment(e, (async () => jsonRes({ status: "pending" })) as typeof fetch)).toEqual({ status: "pending" });
  });
});

describe("service definitions", () => {
  const home = new Home(join(tmpdir(), "acpwp home"));
  const spec = { argv: ["/usr/bin/node", "/opt/a b/cli.js", "run", "--home", home.dir], env: { PATH: "/usr/bin:/bin", ACP_WEB_PROXY_HOME: home.dir }, home };

  it("writes a launchd plist, a systemd unit and a Windows launcher", () => {
    const plist = launchdPlist(spec);
    expect(plist).toContain("<string>/opt/a b/cli.js</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    const unit = systemdUnit(spec);
    expect(unit).toContain('ExecStart=/usr/bin/node "/opt/a b/cli.js" run --home');
    expect(unit).toContain("Restart=always");
    const cmd = windowsLauncher(spec);
    expect(cmd).toContain('"/opt/a b/cli.js" "run"');
    expect(cmd).toContain("goto loop");
  });

  it("parses subcommands and flags", () => {
    expect(parseArgs(["install", "https://c", "--agents", "claude,codex", "--wait"])).toEqual({ _: ["install", "https://c"], agents: "claude,codex", wait: true });
  });
});

/** carrier's enrollment + runner endpoints, just enough for `run`. */
async function fakeCarrierHttp() {
  const state = { approved: false, registered: null as any };
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.endsWith("/poll")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state.approved ? { status: "approved", runner_id: "r1", runner_name: "test-laptop", token: "r1.secret" } : { status: "pending" }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== "Bearer r1.secret") {
      socket.write("HTTP/1.1 401 No\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.method === "_proxy/register") {
          state.registered = msg.params;
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { runner_id: "r1", name: "test-laptop" } }));
        }
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => r()); }));
  return { state, url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

describe("acp-web-proxy run", () => {
  it("waits for approval, stores the credential and connects", async () => {
    if (!existsSync(CLI)) throw new Error("run `npm run build` first");
    const carrier = await fakeCarrierHttp();
    const dir = mkdtempSync(join(tmpdir(), "acpwp-home-"));
    mkdirSync(join(dir, "logs"), { recursive: true });
    const home = new Home(dir);
    writeFileSync(home.configFile, `carrier: {url: "${carrier.url()}"}\nagents:\n  fake: {command: ["${process.execPath.replace(/\\/g, "/")}", "${FAKE.replace(/\\/g, "/")}"]}\n`);
    home.writeJson(home.enrollmentFile, { carrier_url: carrier.url(), enrollment_id: "e1", poll_token: "pt", code: "123456", expires_at: new Date(Date.now() + 600_000).toISOString(), interval_s: 1 }, true);
    const child: ChildProcess = spawn(process.execPath, [CLI, "run", "--home", dir], { stdio: "ignore" });
    closers.push(() => { child.kill("SIGTERM"); });
    await until(() => home.status()?.state === "waiting_for_approval", 8000);
    expect(home.status()?.code).toBe("123456");
    carrier.state.approved = true;
    await until(() => home.status()?.state === "connected", 15000);
    expect(home.status()).toMatchObject({ runner_id: "r1", runner_name: "test-laptop", agents: ["fake"] });
    expect(carrier.state.registered).toMatchObject({ runner_id: "r1", agents: ["fake"] });
    expect(JSON.parse(readFileSync(home.credentialsFile, "utf8")).token).toBe("r1.secret");
    expect(existsSync(home.enrollmentFile)).toBe(false);
  }, 30000);
});
