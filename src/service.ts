/**
 * Run the runner in the background, started again at login and after a crash,
 * without admin rights:
 *
 *   macOS    a launchd agent   ~/Library/LaunchAgents/<label>.plist
 *   Linux    a systemd --user unit, else a detached process (no autostart)
 *   Windows  a hidden restart loop started from the user's Startup folder
 *
 * Every variant runs `<node> <cli.js> run --home <dir>`, which records its pid
 * in <home>/runner.pid.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Home } from "./home.js";

export const LABEL = "com.github.comtihon.acp-web-proxy";
const UNIT = "acp-web-proxy.service";

export type ServiceKind = "launchd" | "systemd" | "startup-folder" | "background";

export interface ServiceSpec {
  /** argv of the runner: [node, cli.js, "run", "--home", dir] */
  argv: string[];
  env: Record<string, string>;
  home: Home;
}

export interface ServiceStatus {
  kind: ServiceKind | null;
  running: boolean;
  pid?: number;
  detail?: string;
}

interface PidFile {
  pid: number;
  ppid?: number;
  started_at?: string;
}

function sh(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export function pidFile(home: Home): string {
  return join(home.dir, "runner.pid");
}

export function writePid(home: Home): void {
  writeFileSync(pidFile(home), JSON.stringify({ pid: process.pid, ppid: process.ppid, started_at: new Date().toISOString() }));
}

function readPid(home: Home): PidFile | null {
  try {
    return JSON.parse(readFileSync(pidFile(home), "utf8")) as PidFile;
  } catch {
    return null;
  }
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killPid(pid: number): void {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(pid, "SIGTERM");
  } catch {
    /* gone */
  }
}

// ── launchd ────────────────────────────────────────────────────────────────

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlist(spec: ServiceSpec): string {
  const log = xml(spec.home.logFile);
  const args = spec.argv.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function launchdDomain(): string {
  return `gui/${userInfo().uid}`;
}

// ── systemd ────────────────────────────────────────────────────────────────

/** Quote for systemd; `$` is expanded in ExecStart= but not in Environment=. */
function systemdQuote(s: string, dollar = true): string {
  if (!/[\s"'\\$%;]/.test(s)) return s;
  let q = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (dollar) q = q.replace(/\$/g, "$$$$");
  return `"${q}"`;
}

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`, false)}`).join("\n");
  const log = spec.home.logFile;
  return `[Unit]
Description=acp-web-proxy runner for carrier
After=network-online.target

[Service]
ExecStart=${spec.argv.map((a) => systemdQuote(a)).join(" ")}
${env}
Restart=always
RestartSec=5
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

function unitPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", UNIT);
}

function systemdAvailable(): boolean {
  return sh("systemctl", ["--user", "show-environment"]).ok;
}

// ── Windows ────────────────────────────────────────────────────────────────

function startupDir(): string {
  return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

function cmdQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export function windowsLauncher(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).map(([k, v]) => `set "${k}=${v}"`).join("\r\n");
  return [
    "@echo off",
    "rem acp-web-proxy runner: restart loop (written by `acp-web-proxy install`)",
    env,
    ":loop",
    `${spec.argv.map(cmdQuote).join(" ")} >> ${cmdQuote(spec.home.logFile)} 2>&1`,
    "timeout /t 5 /nobreak >nul",
    "goto loop",
    "",
  ].join("\r\n");
}

/** Runs the launcher without a console window. */
export function windowsHiddenVbs(launcher: string): string {
  return `CreateObject("WScript.Shell").Run """${launcher.replace(/"/g, '""')}""", 0, False\r\n`;
}

// ── install / uninstall / status ───────────────────────────────────────────

/** Stop whatever runner is running for this home (any kind). */
export function stopService(home: Home): void {
  if (process.platform === "darwin" && existsSync(plistPath())) {
    sh("launchctl", ["bootout", `${launchdDomain()}/${LABEL}`]);
  } else if (process.platform === "linux" && existsSync(unitPath()) && systemdAvailable()) {
    sh("systemctl", ["--user", "stop", UNIT]);
  }
  const p = readPid(home);
  if (p) {
    // On Windows the parent is the restart loop; kill it first so it does not respawn.
    if (process.platform === "win32" && p.ppid && alive(p.ppid)) killPid(p.ppid);
    if (alive(p.pid)) killPid(p.pid);
    rmSync(pidFile(home), { force: true });
  }
}

function startBackground(spec: ServiceSpec): void {
  const out = openSync(spec.home.logFile, "a");
  const [cmd, ...args] = spec.argv;
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...spec.env },
    windowsHide: true,
  });
  child.unref();
}

export function installService(spec: ServiceSpec, opts: { background?: boolean } = {}): { kind: ServiceKind; note?: string } {
  spec.home.ensure();
  stopService(spec.home);
  if (opts.background) {
    startBackground(spec);
    return { kind: "background", note: "runs until logout or reboot; run `acp-web-proxy install` again to restart it" };
  }
  if (process.platform === "darwin") {
    const path = plistPath();
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(path, launchdPlist(spec));
    const boot = sh("launchctl", ["bootstrap", launchdDomain(), path]);
    if (!boot.ok) {
      // Older macOS: the legacy subcommands.
      sh("launchctl", ["unload", path]);
      const load = sh("launchctl", ["load", "-w", path]);
      if (!load.ok) throw new Error(`launchctl could not load ${path}: ${boot.out || load.out}`);
    }
    return { kind: "launchd" };
  }
  if (process.platform === "win32") {
    const launcher = join(spec.home.dir, "runner.cmd");
    writeFileSync(launcher, windowsLauncher(spec));
    const vbs = windowsHiddenVbs(launcher);
    writeFileSync(join(spec.home.dir, "runner-hidden.vbs"), vbs);
    mkdirSync(startupDir(), { recursive: true });
    writeFileSync(join(startupDir(), "acp-web-proxy.vbs"), vbs);
    const child = spawn("wscript.exe", [join(spec.home.dir, "runner-hidden.vbs")], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { kind: "startup-folder" };
  }
  if (systemdAvailable()) {
    const path = unitPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, systemdUnit(spec));
    sh("systemctl", ["--user", "daemon-reload"]);
    const r = sh("systemctl", ["--user", "enable", "--now", UNIT]);
    if (!r.ok) throw new Error(`systemctl --user enable --now ${UNIT} failed: ${r.out}`);
    sh("systemctl", ["--user", "restart", UNIT]);
    const linger = sh("loginctl", ["show-user", userInfo().username, "--property=Linger"]);
    return {
      kind: "systemd",
      note: linger.out.includes("Linger=yes")
        ? undefined
        : `starts at login; to keep it running while logged out: loginctl enable-linger ${userInfo().username}`,
    };
  }
  startBackground(spec);
  return { kind: "background", note: "no systemd user session: started in the background without autostart" };
}

export function uninstallService(home: Home): void {
  stopService(home);
  if (process.platform === "darwin") rmSync(plistPath(), { force: true });
  if (process.platform === "win32") {
    rmSync(join(startupDir(), "acp-web-proxy.vbs"), { force: true });
    rmSync(join(home.dir, "runner.cmd"), { force: true });
    rmSync(join(home.dir, "runner-hidden.vbs"), { force: true });
  }
  if (process.platform === "linux" && existsSync(unitPath())) {
    if (systemdAvailable()) sh("systemctl", ["--user", "disable", UNIT]);
    rmSync(unitPath(), { force: true });
    if (systemdAvailable()) sh("systemctl", ["--user", "daemon-reload"]);
  }
}

export function serviceStatus(home: Home): ServiceStatus {
  const p = readPid(home);
  const running = alive(p?.pid);
  let kind: ServiceKind | null = null;
  let detail: string | undefined;
  if (process.platform === "darwin" && existsSync(plistPath())) {
    kind = "launchd";
    const r = sh("launchctl", ["print", `${launchdDomain()}/${LABEL}`]);
    detail = /state = (\w+)/.exec(r.out)?.[1];
  } else if (process.platform === "linux" && existsSync(unitPath())) {
    kind = "systemd";
    detail = sh("systemctl", ["--user", "is-active", UNIT]).out || undefined;
  } else if (process.platform === "win32" && existsSync(join(startupDir(), "acp-web-proxy.vbs"))) {
    kind = "startup-folder";
  } else if (p) {
    kind = "background";
  }
  return { kind, running, pid: running ? p?.pid : undefined, detail };
}
