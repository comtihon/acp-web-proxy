# Runners: connecting a machine to carrier

A **runner** is an `acp-web-proxy` in dial mode on a machine carrier cannot
reach (a laptop, a VM behind NAT). It dials carrier, announces its local ACP
agents (Claude Code, Codex, …), and carrier drives them in workflow steps.

```
acp-web-proxy (runner) ──control socket──► carrier  /api/v1/acp/runners/connect
                       ──data socket(s)──► carrier  /api/v1/acp/runners/connect/connections/<id>
```

## Install

```bash
npx -y github:comtihon/acp-web-proxy install https://carrier.example.com
```

`install`:

1. finds carrier's API (the URL may be the API or the carrier-bridge UI, whose
   `config.js` names the API);
2. detects local agents (`claude` → `claude-agent-acp`, `codex` → `codex-acp`);
3. installs itself globally when run from an `npx` cache, so the service has a
   stable path;
4. writes `config.yaml` into the home directory (below) and starts a user
   service (launchd / systemd --user / a Windows logon task) running
   `acp-web-proxy run`;
5. asks carrier for an enrollment and prints the **approval number**; it does
   not wait (the service polls), so an agent running the command is not held
   past its tool timeout.

Other commands: `status [--json]`, `logs [-n N]`, `uninstall [--purge]`,
`run` (what the service executes).

Home directory (`ACP_WEB_PROXY_HOME` overrides):

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/acp-web-proxy` |
| Linux | `$XDG_CONFIG_HOME/acp-web-proxy` (`~/.config/acp-web-proxy`) |
| Windows | `%APPDATA%\acp-web-proxy` |

Files: `config.yaml`, `credentials.json` (0600), `enrollment.json`,
`status.json`, `logs/proxy.log`, `state/` (per-connection state).

## Enrollment: approval by number

```
runner                                   carrier                              user (carrier UI)
POST /api/v1/acp/runners/enrollments ──► pending enrollment
  {hostname, os, arch, tz, version,      ◄── {enrollment_id, poll_token, code,
   agents, default_agent}                     expires_at, interval_s, approve_url?}
prints "enter 482 913"
                                                                              opens Runners → Approve device,
                                         POST …/enrollments/lookup {code} ◄── types 482913
                                         ──► {enrollment: hostname, os, agents, ip, …}
                                         POST …/enrollments/{id}/approve ◄── Approve (name, visibility, agents)
                                              {code, name, visibility, team_id, agents}
GET …/enrollments/{id}/poll ─────────►   (Authorization: Bearer <poll_token>)
  ◄── {status: "approved", runner_id, runner_name, token}   (once; afterwards 410)
```

- The **code** (6 digits) only selects which pending enrollment is approved.
  The credential is released only to the holder of the **poll_token**, which
  never leaves the machine. The code never appears in a URL.
- Codes are unique among pending enrollments, single-use, stored hashed, and
  expire (`ACP_RUNNER_ENROLLMENT_TTL_S`, default 600 s).
- Lookup/approve need a logged-in user with WRITE (and, when
  `ACP_RUNNER_ENROLL_ROLES` is set, one of those roles; super admins always).
  Wrong codes are limited per user (5 per 10 min); enrollment creation per IP.
- The approver owns the runner (private by default) and the agent definitions
  created for it (`default_runtime: "runner"`, `protocol: "acp"`).

Poll statuses: `pending`, `approved` (with token), `denied`, `expired`;
HTTP 410 once the token was handed out, 404 for an unknown enrollment.

## Runner credential

`token` = `<runner_id>.<secret>`; carrier stores a hash of the secret. Sent as
`Authorization: Bearer <token>` on the control and data sockets and on
`DELETE /api/v1/acp/runners/self` (self-revoke, used by `uninstall --purge`).
Deleting the runner in carrier revokes it: sockets are refused with HTTP 403
(or closed with **4403**), and the proxy stops reconnecting and reports
`revoked`.

## Control socket

JSON-RPC 2.0, one frame per text message.

| Direction | Method | Params | Result |
|---|---|---|---|
| runner → carrier | `_proxy/register` | `{runner_id, agents, default_agent, labels, version, hostname, os, arch, tz, workspace?}` | `{runner_id, name}` |
| carrier → runner | `_proxy/open` | `{connection_id, last_seq, resume}` | `{connection_id}` |
| carrier → runner | `_proxy/close` | `{connection_id}` | `{}` |
| carrier → runner | `_proxy/ping` | – | `{connections}` |

- `_proxy/open` makes the runner dial `<connect url>/connections/<connection_id>`,
  a data socket that behaves exactly like a listen-mode `/acp` socket
  (replay after `last_seq`). With `resume: true` the connection must already
  exist (error otherwise); without it a new connection is created.
- `url` in `_proxy/open` is accepted only on the same origin as the connect URL.
- Both sides ping; the runner reconnects with exponential backoff (1 s … 60 s,
  jitter). HTTP 401/403 or close code 4401/4403 = revoked: no reconnect.
- Carrier keeps one control socket per runner; a new one replaces the old
  (closed with 4000). Live sockets are held in memory, so carrier must run as a
  single replica (or route a runner's sockets to one replica).

## Local policy

`config.yaml` written by `install` sets:

```yaml
policy:
  allow_launch_env: false   # ignore `env` in _proxy/launch
  allow_stdio_mcp: false    # drop stdio (local command) MCP servers from session/new and session/load
```

A runner executes what carrier asks on the user's machine; these keep carrier
from choosing local commands or environment. Carrier also never sends its own
credentials (tool env) to a runner. Agents still answer permission requests
automatically during a run, as they do in pods: connect a machine only for
agents you are happy to let carrier's workflows drive.

## Workspace

`install` sets `workspace_root: ~/carrier-workspaces`; the runner reports it in
`_proxy/register` and creates a session's `cwd` when it lies inside it.
Carrier runs each step in `<workspace>/<run_id>` unless the agent sets
`agent_input.acp_cwd` (e.g. a checkout of your repository).

## Usage limits

When a subscription agent runs out of quota, carrier parks the step
(`waiting_for_quota`) until the reset and continues in the same session (or
reloads it with `session/load` when the connection is gone). Signals used:

- Claude (`claude-agent-acp`): `usage_update._meta["_claude/rateLimit"]`
  (`status`, `resetsAt`, `rateLimitType`) and the `session/prompt` error
  (`-32603`, message `Internal error: You've hit your limit · resets 3pm (Europe/Berlin)`).
- Codex (`codex-acp`): `session/prompt` error `-32603` with
  `data.codex_error_info: "usage_limit_exceeded"` and `data.message`
  `"… Try again at 3:42 PM."` (runner-local time; the runner reports `tz`).
