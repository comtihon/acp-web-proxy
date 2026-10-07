# Plan: carrier agents over ACP

Goal: replace carrier's HTTP poll protocol with pi-cloud-agent
(`/start` `/poll` `/terminate`) by **ACP over WebSocket** through
`acp-web-proxy`, so carrier can drive pi, Claude Code and Codex the same way,
in pods or on remote machines, and so pi's context optimisations live in pi
(`pi-post-compact`) rather than in a wrapper.

```
carrier ──WebSocket (ACP + _proxy/*)──► acp-web-proxy ──stdio (ACP)──► agent
                                         (pod / VM / laptop)            ├─ pi-carrier-agent (pi SDK)
                                                                         ├─ claude-agent-acp
                                                                         └─ codex-acp
```

## Decisions

1. **Proxy is agent-agnostic** (this repo). Relay, numbered replay on
   reconnect, launch hooks, dial-out runners. No agent knowledge.
2. **pi speaks ACP through our own adapter, not `pi-acp`.** pi-acp 0.0.34
   needs pi ≥ 1.x RPC events (`agent_settled`, `get_available_thinking_levels`)
   that pi 0.79.6 lacks, ignores `session/new.mcpServers`, discards pi's stderr,
   auto-cancels free-text questions and reports no token totals. pi-cloud-agent
   already embeds the pi SDK; it becomes **`pi-carrier-agent`**: an ACP agent on
   stdio built on `createAgentSession`. That is the "wrapper that resolves tools
   and MCP config": it is where carrier's `agent_config` turns into pi settings.
3. **Context optimisations move to `pi-post-compact`** (pi extension), so they
   run inside pi's own loop (the fetch interceptor is deleted). Items that are
   not context optimisations go elsewhere — see "Compaction inventory".
4. **Carrier keeps everything that is not transport**: runtimes (helm/docker/
   local), output-protocol extraction, meta-LLM quality gate, output mapping,
   dynamic workflows. Only the spawn→/start→poll part is replaced, behind a
   per-agent `protocol: acp` flag, so both paths run side by side.

## Phases

### 1. acp-web-proxy (this repo) — done in v0.1.0
- WebSocket `/acp`, bearer auth, `Acp-Connection-Id` / `Acp-Last-Seq` replay,
  `_proxy/launch|status|shutdown`, `_proxy/agent_exited`, prepare /
  after_prompt / shutdown hooks, idle timeout, dial mode, `/health`.
- Tests with a fake ACP agent; Dockerfile; examples.

### 2. pi-post-compact absorbs the interceptor's optimisations
Branch `feat/absorb-cloud-optimisations` in pi-post-compact.

| pi-cloud-agent (runner.js) | Moves to | Notes |
|---|---|---|
| Meta-LLM compaction of tool results, caveman style (573-605) | pi-post-compact `tool_result` | style via `PI_COMPACT_STYLE` |
| Default `exact`/summarise per tool (742-803) | pi-post-compact `src/defaults.ts` | `PI_REQUIRE_DIRECTIVE=1` restores directive-only |
| Hard truncation 20k + artifact pointer (845-854) | pi-post-compact | `PI_TOOL_RESULT_MAX_CHARS` default 20000 |
| Raw output of every tool to `.tool_artifacts/` (832-843) | pi-post-compact | `PI_ARTIFACT_ALL_RESULTS` |
| `read_artifact` tool (427-440) | dropped | stubs carry a path; the model uses `read` |
| Collapse verbatim results after use (641-676) | already in pi-post-compact | non-destructive (context hook) |
| Collapse large tool-call args (678-695) | pi-post-compact | own threshold `PI_ARG_COLLAPSE_MIN_CHARS` |
| Collapse large assistant text (697-713) | already in pi-post-compact | |
| `reason`/`exact` in tool schemas (471-484) | pi-post-compact `before_provider_request` | openai + anthropic payload shapes |
| Cache-frontier logging (267-290) | pi-post-compact stats event | |
| **Cannot live in pi-post-compact:** | | |
| First-turn `tool_choice` forcing + `stream:false` retries for kimi-k2 (441-630) | pi provider compat option, or a tiny `before_provider_request` extension (forcing only — an extension cannot re-issue a request) | verify kimi-k2 with native pi-mcp-adapter first; may be unnecessary |
| Custom resolver loop + tool stripping (528-995) | deleted | pi's native loop + pi-mcp-adapter proxy `mcp` tool |
| MCP tool-list pre-warm, slim `mcp` schema (1012-1057, 1422-1546) | pi-mcp-adapter (its metadata cache + proxy tool) | runner cache lacked `configHash`, adapter rejected it |
| Final-JSON nudge, forced summary (897-974) | carrier (follow-up `session/prompt` in the same session) | |
| Meta-LLM usage in session stats | pi core (no extension API) — reported via `pi.events`, adapter forwards in `_meta` | |
| Custom-model `contextWindow`/`maxTokens` (1282) | carrier `agent_config` | |

### 3. pi-cloud-agent → `pi-carrier-agent` (ACP agent on the pi SDK)
- `src/acp/` — ACP agent on stdio (`@agentclientprotocol/sdk`, or hand-rolled
  NDJSON as raven does):
  - `initialize` → `{loadSession: true, promptCapabilities: {image: true},
    mcpCapabilities: {http: true, sse: true}}`, advertise `_meta.carrier: {version}`.
  - `session/new {cwd, mcpServers, _meta.carrier: agent_config}` → apply tools,
    credentials, env, model (`resolveModelConfig`), GCS workspace restore +
    `workspace_hook`, write `mcp.json` for pi-mcp-adapter **from ACP
    `mcpServers`** (stdio/http/sse → adapter format), `settings.json`
    (`pi-mcp-adapter`, `pi-post-compact`), `createAgentSession`; system prompt
    as a real system prompt (`before_agent_start`) instead of a user-text prefix.
  - `session/prompt` → `session.prompt()`; pi events → `session/update`
    (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
    `tool_call_update`, `usage_update`); response `{stopReason, _meta.carrier:
    {usage, meta_usage, workspace_path}}` after the workspace upload.
  - `session/cancel` → `session.abort()`.
  - Extension UI select/confirm → `session/request_permission`; input/editor
    (free-text clarify) → `_carrier/ask {question, options}` request to the
    client (carrier answers through its existing question flow).
  - `session/load` → reopen pi session file (persisted in the workspace).
- Keep: `tools.js` (PATH check, per-tool env, blocked-command stubs),
  `workspaceS3.js` (made async), `bin/git-credential-env`, `seed-agent-home`.
- Delete: `server.js`, `backend-client.js`, the fetch interceptor and resolver
  (runner.js 421-998 and helpers), `prewarmMcpCache`.
- Image: pi + pi-mcp-adapter + pi-post-compact + **acp-web-proxy** (entrypoint)
  with `pi-carrier-agent` as the `pi` agent, optional `claude-agent-acp` /
  `codex-acp` agents.

### 4. carrier: ACP executor
- `AgentDefinition.protocol: "http-poll" | "acp"` (default `http-poll`).
- `app/infrastructure/acp/client.py` — asyncio WebSocket ACP client: frame
  counting for `Acp-Last-Seq` resume, request/response correlation, handlers
  for agent→client requests.
- `app/steps/acp_executor.py`:
  1. spawn via the existing runtime with `ACP_PROXY_TOKEN` (fresh per run) in env;
  2. connect `ws://<agent>/acp`, `_proxy/launch {agent}`, `initialize`,
     `session/new {cwd, mcpServers: <from agent_config.mcp_servers>, _meta.carrier: agent_config}`;
  3. `session/prompt` with the task text; stream updates →
     `run.state._agent_progress_<step>`, `_active_tools`, live token usage;
  4. `session/request_permission` → allow (`allow_once`) unless
     `blocked_commands` match; `_carrier/ask` → existing `_pending_question`
     + Slack + reply flow, answer returned to the agent;
  5. stop → `{result, token_usage, meta_token_usage}` → the same
     post-processing as today (structured extraction, meta-LLM gate, mapping);
     if the output protocol is unmet, one follow-up `session/prompt` asking for
     the fields (replaces the runner's JSON nudge);
  6. reconnect with replay on socket loss; on carrier restart, re-attach by the
     stored `connection_id` + `last_seq` (persisted on the agent task).
- Warm pods: a kept proxy connection → new `session/new` instead of `/start`.
- Later: runner endpoints for dial mode
  (`/api/v1/acp/runners/connect`, `/connections/{id}`), runner registry and
  "run this agent on runner X" in agent definitions.

## Risks
- kimi-k2 behaviour without the first-turn `tool_choice` forcing (phase 2).
- Long turns across carrier restarts rely on the proxy's buffer
  (`replay_buffer`, `idle_timeout_s`) — size both to the longest expected gap.
- claude/codex adapters: headless auth via env keys; permission requests must
  be answered or the turn hangs (carrier auto-answers).
