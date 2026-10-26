/**
 * `acp-web-proxy run`: what the installed service executes.
 *
 * Without credentials it polls the pending enrollment until a user approves
 * the number in carrier's UI; then it keeps the control socket to carrier
 * open. It never starts a new enrollment on its own (each one shows the user a
 * new number): after an expiry, denial or revocation it waits until
 * `install` writes a new enrollment or credentials.
 */

import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { normalizeConfig, type ProxyConfig } from "./config.js";
import { startDial, type DialHandle } from "./dial.js";
import { connectUrl, pollEnrollment } from "./enroll.js";
import type { Home } from "./home.js";
import type { Logger } from "./log.js";
import { writePid } from "./service.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function loadRunnerConfig(home: Home, runnerId: string, token: string, carrierUrl: string): ProxyConfig {
  const raw = (parseYaml(readFileSync(home.configFile, "utf8")) ?? {}) as Record<string, unknown>;
  const carrier = (raw.carrier ?? {}) as Record<string, unknown>;
  delete raw.carrier;
  const dial = (raw.dial ?? {}) as Record<string, unknown>;
  return normalizeConfig({
    state_dir: home.stateDir,
    ...raw,
    listen: null,
    dial: { ...dial, url: connectUrl(String(carrier.url ?? carrierUrl)), token, runner_id: runnerId },
  });
}

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Resolves once install has written a new enrollment or new credentials. */
async function waitForInstall(home: Home, shouldStop: () => boolean): Promise<void> {
  const before = [mtime(home.enrollmentFile), mtime(home.credentialsFile)];
  while (!shouldStop()) {
    await sleep(5000);
    if (mtime(home.enrollmentFile) !== before[0] || mtime(home.credentialsFile) !== before[1]) return;
  }
}

export async function runRunner(home: Home, log: Logger): Promise<void> {
  home.ensure();
  writePid(home);
  let stopping = false;
  let dial: DialHandle | null = null;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info("stopping", { signal: sig });
    await dial?.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));

  while (!stopping) {
    const creds = home.credentials();
    if (!creds) {
      const e = home.enrollment();
      if (!e) {
        if (!home.status() || home.status()!.state === "enrolling") home.setStatus({ state: "error", error: "not enrolled: run `acp-web-proxy install <carrier url>`" });
        await waitForInstall(home, () => stopping);
        continue;
      }
      home.setStatus({ state: "waiting_for_approval", carrier_url: e.carrier_url, code: e.code, expires_at: e.expires_at, approve_url: e.approve_url });
      const r = await pollEnrollment(e);
      if (r.status === "pending" || r.status === "error") {
        if (r.status === "error") log.warn("enrollment poll failed", { error: r.error });
        if (Date.parse(e.expires_at) < Date.now() - 60_000) {
          home.remove(home.enrollmentFile);
          home.setStatus({ state: "expired", error: "the approval number expired; run `acp-web-proxy install` again for a new one" });
          continue;
        }
        await sleep(Math.max(2, e.interval_s) * 1000);
        continue;
      }
      if (r.status === "approved") {
        home.writeJson(home.credentialsFile, { carrier_url: e.carrier_url, runner_id: r.runner_id, runner_name: r.runner_name, token: r.token }, true);
        home.remove(home.enrollmentFile);
        log.info("approved", { runner: r.runner_id, name: r.runner_name });
        home.setStatus({ state: "approved", runner_id: r.runner_id, runner_name: r.runner_name });
        continue;
      }
      home.remove(home.enrollmentFile);
      home.setStatus(
        r.status === "denied"
          ? { state: "denied", error: "the request was denied in carrier" }
          : { state: "expired", error: "the approval number expired; run `acp-web-proxy install` again for a new one" },
      );
      continue;
    }

    let cfg: ProxyConfig;
    try {
      cfg = loadRunnerConfig(home, creds.runner_id, creds.token, creds.carrier_url);
    } catch (err) {
      home.setStatus({ state: "error", error: `config: ${(err as Error).message}` });
      await waitForInstall(home, () => stopping);
      continue;
    }
    let revoked = false;
    const credsAt = mtime(home.credentialsFile);
    dial = startDial(cfg, log, undefined, {
      onState: (state, info) => {
        if (state === "revoked") revoked = true;
        home.setStatus({
          state,
          carrier_url: creds.carrier_url,
          runner_id: creds.runner_id,
          runner_name: info.name ?? creds.runner_name,
          agents: Object.keys(cfg.agents),
          ...(info.error ? { error: info.error } : {}),
        });
      },
    });
    // Run until revoked, or until install replaced the credentials.
    while (!stopping && !revoked && mtime(home.credentialsFile) === credsAt) await sleep(2000);
    await dial.close();
    dial = null;
    if (revoked) {
      home.remove(home.credentialsFile);
      home.setStatus({ state: "revoked", error: "carrier revoked this runner; run `acp-web-proxy install <carrier url>` to connect it again" });
    }
  }
}
