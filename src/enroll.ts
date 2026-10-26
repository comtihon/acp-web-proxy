/**
 * Enrollment against carrier: find its API, ask for an enrollment (carrier
 * answers with a number the user types into carrier's UI), poll until it is
 * approved, denied or expired. See docs/runners.md.
 */

import { arch, hostname } from "node:os";
import type { Enrollment } from "./home.js";
import { VERSION } from "./dial.js";

export const RUNNERS_PATH = "/api/v1/acp/runners";

export interface CarrierEndpoints {
  /** Carrier's API base, e.g. https://carrier.example.com */
  api: string;
  /** carrier-bridge UI, when known (for the approval link). */
  ui: string | null;
}

export function normalizeUrl(input: string): string {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/+$/, "");
}

/** wss://…/api/v1/acp/runners/connect for an API base. */
export function connectUrl(api: string): string {
  const u = new URL(api + `${RUNNERS_PATH}/connect`);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  return u.toString();
}

type Fetch = typeof fetch;

async function getJson(f: Fetch, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await f(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function isCarrier(f: Fetch, api: string): Promise<Record<string, unknown> | null> {
  const info = await getJson(f, `${api}${RUNNERS_PATH}/info`);
  return info && info.runners === true ? info : null;
}

/**
 * The URL a user pastes may be carrier's API or the carrier-bridge UI. The UI
 * is a static site whose config.js names the API (BACKEND_URL).
 */
export async function discoverCarrier(input: string, f: Fetch = fetch): Promise<CarrierEndpoints> {
  const url = normalizeUrl(input);
  const direct = await isCarrier(f, url);
  if (direct) return { api: url, ui: typeof direct.ui_url === "string" && direct.ui_url ? direct.ui_url.replace(/\/+$/, "") : null };

  const origin = new URL(url).origin;
  for (const candidate of [...new Set([`${url}/config.js`, `${origin}/config.js`])]) {
    let text = "";
    try {
      const res = await f(candidate, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      text = await res.text();
    } catch {
      continue;
    }
    const m = /BACKEND_URL["']?\s*:\s*["']([^"']+)["']/.exec(text);
    if (!m) continue;
    const api = normalizeUrl(new URL(m[1], url).toString());
    const info = await isCarrier(f, api);
    if (info) return { api, ui: url };
  }
  throw new Error(
    `${url} does not look like carrier: neither ${url}${RUNNERS_PATH}/info nor a carrier-bridge config.js answered. ` +
      "Use the carrier API URL (or the carrier UI URL) your team gave you.",
  );
}

export interface EnrollmentRequest {
  hostname: string;
  os: string;
  arch: string;
  tz: string;
  version: string;
  agents: string[];
  default_agent: string;
}

export function enrollmentRequest(agents: string[], defaultAgent: string): EnrollmentRequest {
  return {
    hostname: hostname(),
    os: process.platform,
    arch: arch(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    version: VERSION,
    agents,
    default_agent: defaultAgent,
  };
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (body?.detail) return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}`;
}

export async function createEnrollment(
  carrier: CarrierEndpoints,
  req: EnrollmentRequest,
  f: Fetch = fetch,
): Promise<Enrollment> {
  const res = await f(`${carrier.api}${RUNNERS_PATH}/enrollments`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`carrier refused the enrollment: ${await errorText(res)}`);
  const b = (await res.json()) as Record<string, unknown>;
  return {
    carrier_url: carrier.api,
    enrollment_id: String(b.enrollment_id),
    poll_token: String(b.poll_token),
    code: String(b.code),
    expires_at: String(b.expires_at),
    interval_s: typeof b.interval_s === "number" ? b.interval_s : 5,
    approve_url: (b.approve_url as string | null | undefined) ?? (carrier.ui ? `${carrier.ui}/#approve-runner` : null),
  };
}

export type PollResult =
  | { status: "pending" }
  | { status: "approved"; runner_id: string; runner_name?: string; token: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; error: string };

export async function pollEnrollment(e: Enrollment, f: Fetch = fetch): Promise<PollResult> {
  let res: Response;
  try {
    res = await f(`${e.carrier_url}${RUNNERS_PATH}/enrollments/${encodeURIComponent(e.enrollment_id)}/poll`, {
      headers: { authorization: `Bearer ${e.poll_token}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { status: "error", error: String(err) };
  }
  // 404: carrier forgot it (expired and cleaned up); 410: the token was already handed out.
  if (res.status === 404 || res.status === 410) return { status: "expired" };
  if (!res.ok) return { status: "error", error: await errorText(res) };
  const b = (await res.json()) as Record<string, unknown>;
  switch (b.status) {
    case "approved":
      return { status: "approved", runner_id: String(b.runner_id), runner_name: b.runner_name as string | undefined, token: String(b.token) };
    case "denied":
      return { status: "denied" };
    case "expired":
      return { status: "expired" };
    default:
      return { status: "pending" };
  }
}

/** Remove the runner from carrier with its own credential (uninstall --purge). */
export async function selfRevoke(api: string, token: string, f: Fetch = fetch): Promise<boolean> {
  try {
    const res = await f(`${api}${RUNNERS_PATH}/self`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/** "482913" → "482 913" */
export function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
