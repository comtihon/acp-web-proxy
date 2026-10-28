/**
 * Workspace sync: restore a session's working directory from a URL before the
 * agent starts, and upload it after every turn.
 *
 * The client asks for it in `_proxy/launch` `config.workspace`:
 *
 *   {dir, download_url?, upload_url?, upload_headers?, exclude?}
 *
 * The archive is a gzipped tar of `dir`'s contents. The URLs are plain HTTP
 * (GET to restore, PUT to upload) — typically pre-signed object-storage URLs,
 * so the machine needs no storage credentials and the proxy knows no provider.
 * `dir` must lie inside the configured `workspace_root`.
 */

import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openAsBlob, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface WorkspaceSync {
  dir: string;
  download_url?: string;
  upload_url?: string;
  upload_headers?: Record<string, string>;
  exclude?: string[];
}

export type RestoreOutcome = "restored" | "empty" | "kept";

const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;

/** The launch config's `workspace`, validated; null when absent; a string on error. */
export function parseWorkspaceSync(raw: unknown, root: string | undefined): WorkspaceSync | null | string {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "config.workspace must be an object";
  const w = raw as Record<string, unknown>;
  if (!root) return "config.workspace needs `workspace_root` in the proxy config";
  if (typeof w.dir !== "string" || !isAbsolute(w.dir)) return "config.workspace.dir must be an absolute path";
  const rel = relative(resolve(root), resolve(w.dir));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return `config.workspace.dir must lie inside ${root}`;
  const url = (k: string) => {
    const v = w[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" || !/^https?:\/\//.test(v)) throw new Error(`config.workspace.${k} must be an http(s) URL`);
    return v;
  };
  try {
    return {
      dir: resolve(w.dir),
      download_url: url("download_url"),
      upload_url: url("upload_url"),
      upload_headers: isStringMap(w.upload_headers) ? w.upload_headers : undefined,
      exclude: Array.isArray(w.exclude) ? w.exclude.filter((e): e is string => typeof e === "string" && e.length > 0) : undefined,
    };
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Restore `dir` from `download_url`. A directory that already has files is
 * kept as it is: it is the same run's work, at least as new as the last
 * upload (a relaunch after a dropped connection or a usage-limit pause).
 */
export async function restoreWorkspace(ws: WorkspaceSync, tmpDir: string): Promise<RestoreOutcome> {
  if (existsSync(ws.dir) && readdirSync(ws.dir).length > 0) return "kept";
  mkdirSync(ws.dir, { recursive: true });
  if (!ws.download_url) return "empty";
  const res = await fetch(ws.download_url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
  // Nothing uploaded yet: the first step of a run starts empty.
  if (res.status === 404) return "empty";
  if (!res.ok || !res.body) throw new Error(`GET workspace archive: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  mkdirSync(tmpDir, { recursive: true });
  const archive = join(tmpDir, "workspace-download.tar.gz");
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(archive));
    await tar(["-xzf", archive, "-C", ws.dir]);
  } finally {
    rmSync(archive, { force: true });
  }
  return "restored";
}

/** Archive `dir` and PUT it to `upload_url`; resolves the archive size in bytes. */
export async function persistWorkspace(ws: WorkspaceSync, tmpDir: string): Promise<number> {
  if (!ws.upload_url) return 0;
  mkdirSync(tmpDir, { recursive: true });
  const archive = join(tmpDir, "workspace-upload.tar.gz");
  try {
    const excludes = (ws.exclude ?? []).map((e) => `--exclude=${e}`);
    // GNU tar exits 1 when a file changed while it was read; the archive is still whole.
    await tar([...excludes, "-czf", archive, "-C", ws.dir, "."], [0, 1]);
    const body = await openAsBlob(archive);
    const res = await fetch(ws.upload_url, {
      method: "PUT",
      headers: { "content-type": "application/gzip", ...(ws.upload_headers ?? {}) },
      body,
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`PUT workspace archive: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return body.size;
  } finally {
    rmSync(archive, { force: true });
  }
}

function tar(args: string[], okCodes: number[] = [0]): Promise<void> {
  return new Promise((done, fail) => {
    execFile("tar", args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      if (okCodes.includes(code)) done();
      else fail(new Error(`tar ${args.join(" ")} failed (exit ${code}): ${String(stderr).slice(-500) || err?.message}`));
    });
  });
}

function isStringMap(v: unknown): v is Record<string, string> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
}
