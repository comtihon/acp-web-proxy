#!/usr/bin/env node
import { loadConfig, normalizeConfig, type ProxyConfig } from "./config.js";
import { createLogger } from "./log.js";
import { ConnectionRegistry, startServer } from "./server.js";
import { startDial } from "./dial.js";

const USAGE = `acp-web-proxy — serve a local ACP agent over WebSocket

Usage:
  acp-web-proxy --config <file.yaml>
  acp-web-proxy --agent "<command>" [--port 8000] [--host 127.0.0.1] [--token <t>]

Options:
  --config <file>   YAML/JSON config (or ACP_PROXY_CONFIG)
  --agent <cmd>     quick start: one agent named "default"
  --host, --port    listen address (quick start)
  --token <t>       bearer token (or ACP_PROXY_TOKEN)
  --insecure        accept connections without a token (local development only)
`;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    process.stdout.write(USAGE);
    return;
  }
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

main().catch((err) => {
  process.stderr.write(`acp-web-proxy: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
