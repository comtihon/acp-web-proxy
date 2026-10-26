#!/usr/bin/env node
import { readFileSync, realpathSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { loadConfig, normalizeConfig, type ProxyConfig } from "./config.js";
import { createLogger } from "./log.js";
import { ConnectionRegistry, startServer } from "./server.js";
import { startDial, VERSION } from "./dial.js";
import { detectAgents, KNOWN_AGENTS } from "./agents.js";
import { createEnrollment, discoverCarrier, enrollmentRequest, formatCode, normalizeUrl, selfRevoke } from "./enroll.js";
import { Home, type Status } from "./home.js";
import { installService, serviceStatus, uninstallService } from "./service.js";
import { runRunner } from "./runner.js";
import { resolveSpawn } from "./spawnCommand.js";

const USAGE = `acp-web-proxy ${VERSION} — serve a local ACP agent over WebSocket

Connect this machine to carrier (installs a background service):
  acp-web-proxy install <carrier url> [--agents claude,codex] [--wait]
  acp-web-proxy status [--json]
  acp-web-proxy logs [-n 100]
  acp-web-proxy uninstall [--purge]

Serve agents directly:
  acp-web-proxy --config <file.yaml>
  acp-web-proxy --agent "<command>" [--port 8000] [--host 127.0.0.1] [--token <t>]

install options:
  --agents <list>   agents to offer (default: every installed one of ${KNOWN_AGENTS.map((a) => a.name).join(", ")})
  --wait            wait until the number is approved (default: return at once)
  --timeout <s>     with --wait (default 600)
  --reenroll        enroll again even if this machine is already connected
  --background      run detached instead of as a login service
  --no-service      only enroll and write the config; start it yourself with \`acp-web-proxy run\`
  --no-global       do not install acp-web-proxy globally when run through npx
  --home <dir>      home directory (or ACP_WEB_PROXY_HOME)

serve options:
  --config <file>   YAML/JSON config (or ACP_PROXY_CONFIG)
  --agent <cmd>     quick start: one agent named "default"
  --host, --port    listen address (quick start)
  --token <t>       bearer token (or ACP_PROXY_TOKEN)
  --insecure        accept connections without a token (local development only)
`;

interface Args {
  _: string[];
  [flag: string]: string | boolean | string[];
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-") || a === "-") {
      out._.push(a);
      continue;
    }
    const key = a.replace(/^--?/, "");
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function homeOf(args: Args): Home {
  return typeof args.home === "string" ? new Home(args.home) : new Home();
}

function say(line = ""): void {
  process.stdout.write(line + "\n");
}

// ── serve (the original mode) ──────────────────────────────────────────────

async function serve(args: Args): Promise<void> {
  const log = createLogger();
  let cfg: ProxyConfig;
  const configPath = (args.config as string) || process.env.ACP_PROXY_CONFIG;
  if (configPath) {
    cfg = loadConfig(configPath);
  } else if (args.agent) {
    const token = (args.token as string) || process.env.ACP_PROXY_TOKEN || "";
    cfg = normalizeConfig({
      listen: { host: (args.host as string) || "127.0.0.1", port: Number(args.port || 8000), path: "/acp" },
      tokens: token ? [token] : [],
      allow_unauthenticated: Boolean(args.insecure),
      agents: { default: { command: String(args.agent) } },
    });
  } else {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const registry = new ConnectionRegistry(cfg, log);
  const closers: Array<() => Promise<void>> = [];
  if (cfg.listen) {
    const h = await startServer(cfg, log, registry);
    closers.push(h.close);
  }
  if (cfg.dial) {
    const h = startDial(cfg, log, registry);
    closers.push(h.close);
  }

  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info("stopping", { signal: sig });
    await Promise.allSettled(closers.map((c) => c()));
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

// ── install ────────────────────────────────────────────────────────────────

function runSync(argv: string[]): { ok: boolean; out: string } {
  const r = resolveSpawn(argv);
  const res = spawnSync(r.file, r.args, { encoding: "utf8", windowsVerbatimArguments: r.windowsVerbatimArguments, windowsHide: true });
  return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

/**
 * A service needs a path that survives: npx runs from a cache that can be
 * cleaned at any time, so install globally first and point the service there.
 */
function stableCliPath(args: Args): string {
  const self = realpathSync(fileURLToPath(import.meta.url));
  if (!/[\\/]_npx[\\/]/.test(self) || args["no-global"]) return self;
  const spec = process.env.ACP_WEB_PROXY_PACKAGE || "github:comtihon/acp-web-proxy";
  say(`Installing acp-web-proxy globally (npm install -g ${spec}) …`);
  const inst = runSync(["npm", "install", "-g", spec]);
  if (!inst.ok) throw new Error(`npm install -g ${spec} failed:\n${inst.out}`);
  const root = runSync(["npm", "root", "-g"]);
  const cli = join(root.out.split(/\r?\n/).pop()!.trim(), "acp-web-proxy", "dist", "cli.js");
  if (!root.ok || !existsSync(cli)) throw new Error(`installed, but ${cli} is missing`);
  return cli;
}

function writeRunnerConfig(home: Home, carrierUrl: string, agents: Record<string, { command: string[] }>): void {
  const names = Object.keys(agents);
  const cfg = {
    carrier: { url: carrierUrl },
    default_agent: names[0],
    // A turn can outlive a short network drop or a carrier restart.
    idle_timeout_s: 3600,
    policy: { allow_launch_env: false, allow_stdio_mcp: false },
    // Each carrier run gets a directory here (unless its agent names another cwd).
    workspace_root: join(homedir(), "carrier-workspaces"),
    agents,
  };
  home.ensure();
  writeFileSync(home.configFile, "# acp-web-proxy runner — written by `acp-web-proxy install`; edit and restart to change.\n" + stringifyYaml(cfg));
}

function describe(st: Status | null): string {
  if (!st) return "not installed";
  switch (st.state) {
    case "waiting_for_approval":
      return "waiting for approval";
    case "connected":
      return `connected${st.runner_name ? ` as "${st.runner_name}"` : ""}`;
    default:
      return st.state.replace(/_/g, " ");
  }
}

function approvalInstructions(st: Pick<Status, "code" | "expires_at" | "approve_url">): string[] {
  const expires = st.expires_at ? new Date(st.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return [
    `  Approval number:  ${formatCode(st.code ?? "")}${expires ? `   (expires ${expires})` : ""}`,
    st.approve_url
      ? `  Open ${st.approve_url} and enter the number.`
      : "  Open carrier's web UI → Runners → Approve device, and enter the number.",
  ];
}

async function install(args: Args): Promise<void> {
  const target = args._[1];
  if (!target) throw new Error("usage: acp-web-proxy install <carrier url>");
  const home = homeOf(args);
  const only = typeof args.agents === "string" ? args.agents.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  say(`Looking up carrier at ${normalizeUrl(target)} …`);
  const carrier = await discoverCarrier(target);
  say(`  carrier API: ${carrier.api}${carrier.ui ? `\n  carrier UI:  ${carrier.ui}` : ""}`);

  const agents = detectAgents(only);
  if (Object.keys(agents).length === 0) {
    throw new Error(
      "no supported coding agent found on PATH (claude, codex, gemini). Install and log in to one first " +
        "(e.g. `npm i -g @anthropic-ai/claude-code && claude`), or name one with --agents.",
    );
  }
  say(`  agents:      ${Object.entries(agents).map(([n, a]) => `${n} (${a.command.join(" ")})`).join(", ")}`);

  const cli = stableCliPath(args);
  writeRunnerConfig(home, carrier.api, agents);

  const creds = home.credentials();
  const reuse = creds && creds.carrier_url === carrier.api && !args.reenroll;
  if (!reuse) {
    home.remove(home.credentialsFile);
    const e = await createEnrollment(carrier, enrollmentRequest(Object.keys(agents), Object.keys(agents)[0]));
    home.writeJson(home.enrollmentFile, e, true);
    home.setStatus({ state: "waiting_for_approval", carrier_url: carrier.api, code: e.code, expires_at: e.expires_at, approve_url: e.approve_url, agents: Object.keys(agents) });
  }

  if (args["no-service"]) {
    say(`\nConfig written to ${home.configFile}. Start the runner with:\n  node ${cli} run --home "${home.dir}"`);
  } else {
    const svc = installService(
      { argv: [process.execPath, cli, "run", "--home", home.dir], env: { PATH: process.env.PATH ?? "", ACP_WEB_PROXY_HOME: home.dir }, home },
      { background: !!args.background },
    );
    say(`  service:     ${svc.kind}${svc.note ? ` — ${svc.note}` : ""}`);
  }

  const st = home.status();
  say("");
  if (reuse) {
    say(`This machine is already connected to ${carrier.api} as "${creds!.runner_name ?? creds!.runner_id}"; the runner was restarted.`);
    say("Use --reenroll to connect it again under a new approval.");
    return;
  }
  say("Approve this machine in carrier:");
  for (const l of approvalInstructions(st ?? {})) say(l);
  say("  Only a signed-in carrier user allowed to add runners can approve it.");
  if (!args.wait) {
    say("\nThe runner keeps waiting in the background. Check with:  acp-web-proxy status");
    return;
  }
  const deadline = Date.now() + Number(args.timeout || 600) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = home.status();
    if (s && ["connected", "denied", "expired", "revoked", "error"].includes(s.state)) {
      say(`\nRunner ${describe(s)}${s.error ? `: ${s.error}` : ""}.`);
      if (s.state !== "connected") process.exitCode = 1;
      return;
    }
  }
  say("\nStill waiting for approval; check later with `acp-web-proxy status`.");
}

// ── status / logs / uninstall ──────────────────────────────────────────────

function status(args: Args): void {
  const home = homeOf(args);
  const st = home.status();
  const svc = serviceStatus(home);
  if (args.json) {
    say(JSON.stringify({ ...st, home: home.dir, service: svc, log: home.logFile }, null, 2));
    return;
  }
  say(`acp-web-proxy runner (${home.dir})`);
  say(`  state:    ${describe(st)}`);
  if (st && st.state === "waiting_for_approval") for (const l of approvalInstructions(st)) say(l.replace(/^ {2}/, "  "));
  if (st?.carrier_url) say(`  carrier:  ${st.carrier_url}`);
  if (st?.agents?.length) say(`  agents:   ${st.agents.join(", ")}`);
  if (st?.error) say(`  note:     ${st.error}`);
  say(`  service:  ${svc.kind ?? "not installed"}${svc.kind ? (svc.running ? `, running (pid ${svc.pid})` : ", not running") : ""}${svc.detail ? ` [${svc.detail}]` : ""}`);
  say(`  log:      ${home.logFile}`);
}

function logs(args: Args): void {
  const home = homeOf(args);
  const n = Number(args.n || args.lines || 100);
  let text = "";
  try {
    text = readFileSync(home.logFile, "utf8");
  } catch {
    say(`no log at ${home.logFile}`);
    return;
  }
  say(text.trimEnd().split(/\r?\n/).slice(-n).join("\n"));
}

async function uninstall(args: Args): Promise<void> {
  const home = homeOf(args);
  uninstallService(home);
  say("Runner service removed.");
  if (!args.purge) {
    say(`Kept ${home.dir} (credentials included); --purge also removes it and the runner in carrier.`);
    return;
  }
  const creds = home.credentials();
  if (creds) {
    const ok = await selfRevoke(creds.carrier_url, creds.token);
    say(ok ? "Removed this runner from carrier." : "Could not reach carrier to remove the runner; delete it in carrier's Runners page.");
  }
  rmSync(home.dir, { recursive: true, force: true });
  say(`Removed ${home.dir}.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.help || args.h || cmd === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (args.version || cmd === "version") {
    say(VERSION);
    return;
  }
  switch (cmd) {
    case "install":
      return install(args);
    case "run":
      return runRunner(homeOf(args), createLogger());
    case "status":
      return status(args);
    case "logs":
      return logs(args);
    case "uninstall":
      return uninstall(args);
    case undefined:
      return serve(args);
    default:
      throw new Error(`unknown command '${cmd}'\n\n${USAGE}`);
  }
}

// Only when executed, not when imported (tests import parseArgs).
const invokedAs = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedAs && invokedAs === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    process.stderr.write(`acp-web-proxy: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

