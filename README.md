# acp-web-proxy

Serve a local [ACP](https://agentclientprotocol.com) agent over WebSocket.

ACP agents (pi, Claude Code via `claude-agent-acp`, Codex via `codex-acp`, …)
speak JSON-RPC over **stdio**: the client has to spawn them. `acp-web-proxy`
runs next to the agent — in a Kubernetes pod, on a VM, on a laptop — and lets
a remote client (e.g. [ai-agents-carrier](https://github.com/comtihon/ai-agents-carrier))
drive it over a WebSocket, with what a network needs and stdio does not:

- **Reconnect with replay.** The agent outlives the socket. Every frame the
  proxy sends is numbered; a client that reconnects with the connection id and
  the number of frames it saw gets the rest replayed, in order — including
  permission requests still waiting for an answer.
- **Launch hooks.** A `prepare` hook turns the client's launch config (tools,
  MCP servers, credentials, workspace restore) into files and env for the
  agent; `after_prompt` runs after every turn *before* the client sees it end
  (e.g. persist the workspace); `shutdown` runs on teardown.
- **Dial-out runners.** On machines with no inbound access the proxy dials the
  client instead; the data plane is identical.
- **Auth** with bearer tokens (constant-time compare), process-group cleanup,
  idle timeout, `/health`.

Frames are relayed **unmodified**; the proxy only adds methods under the
`_proxy/` prefix (ACP reserves `_`-prefixed methods for extensions).

## Connect your machine to carrier

```bash
npx -y github:comtihon/acp-web-proxy install https://carrier.example.com
```

This finds the coding agents installed here (Claude Code, Codex, Gemini CLI),
installs a background service (launchd on macOS, systemd --user on Linux, a
Startup-folder task on Windows) and prints an **approval number**. Enter that
number in carrier's UI (Runners → Approve device); the machine's agents then
show up in carrier and can be used in workflows. Check on it with
`acp-web-proxy status`; remove it with `acp-web-proxy uninstall --purge`.

Asking an agent works too — e.g. tell Claude Code *"install acp-web-proxy and
connect it to https://carrier.example.com"*; it follows [INSTALL.md](INSTALL.md).
How enrollment, revocation and reconnects work: [docs/runners.md](docs/runners.md).

## Quick start

```bash
npm i -g acp-web-proxy
acp-web-proxy --agent "npx -y @agentclientprotocol/claude-agent-acp" --port 8000 --token "$(openssl rand -hex 16)"
```

or with a config file (`--config proxy.yaml`, or `ACP_PROXY_CONFIG`):

```yaml
listen: {host: 0.0.0.0, port: 8000, path: /acp}
tokens: [env:ACP_PROXY_TOKEN]       # `env:NAME` reads the environment
default_agent: pi
idle_timeout_s: 600                 # agent survives this long without a client
replay_buffer: 20000                # frames kept per connection for replay
agents:
  pi:
    command: [pi-carrier-agent]
    cwd: /workspace
    env: {PI_CODING_AGENT_DIR: /home/agent/.pi}
    hooks:
      prepare: [node, /app/prepare.mjs]          # stdin: launch config JSON
      after_prompt: {command: [/app/upload.sh], timeout_s: 600}
      shutdown: [/app/cleanup.sh]
  claude:
    command: [claude-agent-acp]
```

More in [`examples/`](examples).

## Protocol

### Handshake

```
GET /acp HTTP/1.1
Upgrade: websocket
Authorization: Bearer <token>
Acp-Connection-Id: <id>      # optional: re-attach to an existing connection
Acp-Last-Seq: <n>            # optional: frames already received on it

HTTP/1.1 101 Switching Protocols
Acp-Connection-Id: <id>
```

Then every WebSocket **text** message is one JSON-RPC frame, either direction.

### Reconnecting

Count the frames you receive on a connection (1, 2, 3, …). After a drop,
reconnect with `Acp-Connection-Id` and `Acp-Last-Seq: <count>`: frames after
that are replayed before anything new. If they have fallen out of the buffer
the socket closes with **4409**; an unknown/ended connection id gets **404**.
A connection with no socket attached is shut down after `idle_timeout_s`.

### Proxy methods

| Method | Params | Result |
|---|---|---|
| `_proxy/launch` | `{agent?, config?, env?}` | `{connection_id, agent, pid}` — runs `prepare`, starts the agent. Optional: the first ACP frame auto-launches the default agent with no config. |
| `_proxy/status` | – | `{agent, pid, running, exit, stderr_tail, last_seq}` |
| `_proxy/shutdown` | – | `{}`; stops the agent, runs `shutdown`, ends the connection |

Notification: `_proxy/agent_exited {code, signal, stderr_tail}`. Requests the
agent never answered are failed with JSON-RPC error `-32603` when it exits.

### Hooks

Hooks get `ACP_PROXY_CONNECTION_ID`, `ACP_PROXY_AGENT`, `ACP_PROXY_STATE_DIR`
(private per-connection dir) and `ACP_PROXY_CONFIG_FILE` (the launch config,
mode 0600) in their environment.

- **prepare** — stdin: the launch `config` as JSON. May print (last line) a JSON
  object `{env?, cwd?, args?, command?}` merged into the agent's spawn. Non-zero
  exit fails `_proxy/launch` with the hook's stderr.
- **after_prompt** — stdin: the `session/prompt` response frame. The response
  is held until the hook exits (or times out; default 300 s).
- **shutdown** — stdin: `{reason}`.

The agent inherits the proxy's environment **minus** every `ACP_PROXY_*`
variable, plus `agents.<name>.env`, `_proxy/launch` `env`, and the prepare
hook's `env`.

### Dial mode

```yaml
listen: null
dial:
  url: wss://carrier.example.com/api/v1/acp/runners/connect
  token: env:CARRIER_RUNNER_TOKEN
  runner_id: my-laptop
```

The proxy keeps a **control** socket to `url` and announces itself with the
request `_proxy/register {runner_id, agents, default_agent, labels, version,
hostname, os, arch, tz}`. The client asks for a connection with
`_proxy/open {connection_id?, last_seq?, resume?, url?}`; the proxy then dials
a **data** socket to `<url>/connections/<connection_id>` which behaves exactly
like a listen-mode `/acp` socket (`url`, if given, must be on the same origin;
`resume: true` fails for an unknown connection instead of creating one).
`_proxy/close {connection_id}` ends one. The control socket reconnects with
exponential backoff (`reconnect_s` … `reconnect_max_s`, with jitter) and stops
for good when the client refuses the token (HTTP 401/403, close 4401/4403).

### Local policy

```yaml
policy:
  allow_launch_env: false   # ignore `env` in _proxy/launch
  allow_stdio_mcp: false    # drop stdio MCP servers from session/new and session/load
```

Both default to `true`; `install` turns them off, so a remote client cannot
choose commands or environment variables on your machine. String values may
also be `file:PATH` (the file's trimmed contents).

## Relation to ACP's remote transport

ACP's draft *Streamable HTTP & WebSocket transport* RFD defines `/acp`,
`Acp-Connection-Id` and WebSocket upgrade; this proxy follows those names. Its
v1 drops in-flight messages on reconnect — the proxy's numbered replay is what
fills that gap until the RFD's `Last-Event-ID` resumption lands.

## Development

```bash
npm install
npm test          # vitest; uses a fake ACP agent (test/fixtures/fake-agent.mjs)
npm run build
```
