# Installing acp-web-proxy (instructions for an AI agent)

Use this when a user asks you to "install the web proxy" / "connect this machine
to carrier" and gives you a carrier URL.

1. **Node.js ≥ 20** must be on PATH (`node --version`). If it is missing, install
   it with the platform's usual tool (macOS: `brew install node`; Windows:
   `winget install OpenJS.NodeJS.LTS`; Linux: the distribution's package or
   nvm) and confirm with the user before installing system packages.
2. At least one coding agent should be installed and logged in: `claude`
   (Claude Code), `codex` or `gemini`. If none is, tell the user; don't log in
   for them.
3. Run, with the URL the user gave you:

   ```bash
   npx -y github:comtihon/acp-web-proxy install <carrier url>
   ```

   It returns right away and prints an **approval number** and where to enter it.
4. **Tell the user the number** and the place to enter it (carrier UI → Runners →
   Approve device, or the link printed). Say that they should only enter it in
   their own carrier session. Do not try to approve it yourself.
5. After the user says they approved it, run `acp-web-proxy status` and report
   the state. `connected` means done. `expired` or `denied`: run the install
   command again for a new number.

Troubleshooting: `acp-web-proxy logs -n 50`. To remove: `acp-web-proxy uninstall --purge`.
Details: [docs/runners.md](docs/runners.md).
