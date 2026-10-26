/**
 * Which ACP agents this machine can offer. A coding CLI is usable when either
 * its ACP adapter is installed, or the CLI is (then the adapter runs via npx).
 */

import type { ProxyConfig } from "./config.js";
import { which } from "./spawnCommand.js";

export interface KnownAgent {
  name: string;
  /** The coding CLI the user logs in with. */
  cli: string;
  /** ACP adapter binary, when installed globally. */
  adapter?: string;
  /** npm package of the adapter (run with npx when not installed). */
  pkg?: string;
  /** Command when the CLI speaks ACP itself. */
  native?: string[];
}

export const KNOWN_AGENTS: KnownAgent[] = [
  { name: "claude", cli: "claude", adapter: "claude-agent-acp", pkg: "@agentclientprotocol/claude-agent-acp" },
  { name: "codex", cli: "codex", adapter: "codex-acp", pkg: "@zed-industries/codex-acp" },
  { name: "gemini", cli: "gemini", native: ["gemini", "--experimental-acp"] },
];

export type AgentCommands = Record<string, { command: string[] }>;

export function commandFor(agent: KnownAgent, env: NodeJS.ProcessEnv = process.env): string[] {
  if (agent.adapter && which(agent.adapter, env)) return [agent.adapter];
  if (agent.pkg) return ["npx", "-y", agent.pkg];
  return agent.native!;
}

/**
 * Agents to configure: the ones named in `only` (installed or not), else every
 * known agent whose CLI or adapter is on PATH.
 */
export function detectAgents(only?: string[], env: NodeJS.ProcessEnv = process.env): AgentCommands {
  const out: AgentCommands = {};
  for (const agent of KNOWN_AGENTS) {
    const wanted = only ? only.includes(agent.name) : !!(which(agent.cli, env) || (agent.adapter && which(agent.adapter, env)));
    if (wanted) out[agent.name] = { command: commandFor(agent, env) };
  }
  for (const name of only ?? []) {
    if (!out[name]) throw new Error(`unknown agent '${name}' (known: ${KNOWN_AGENTS.map((a) => a.name).join(", ")})`);
  }
  return out;
}

export function agentNames(cfg: Pick<ProxyConfig, "agents">): string[] {
  return Object.keys(cfg.agents);
}
