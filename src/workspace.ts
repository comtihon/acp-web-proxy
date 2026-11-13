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
 *
 * Change detection: a manifest (relative path → `size:mtimeMs`, or
 * `link:<target>` for symlinks) is taken after restore and after every upload;
 * a turn that changed nothing skips the upload. A small sync record per `dir`
 * — the archive's remote version and the last manifest — is kept in
 * `<workspace_root>/.carrier-sync/`, so a relaunch can tell whether another
 * step replaced the archive meanwhile.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openAsBlob,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface WorkspaceSync {
  dir: string;
  /** The proxy's `workspace_root`; the sync record lives under it. */
  root?: string;
  download_url?: string;
  upload_url?: string;
  upload_headers?: Record<string, string>;
  exclude?: string[];
}

export type RestoreOutcome = "restored" | "empty" | "kept" | "replaced";

/** Relative path → `size:mtimeMs` (regular files) or `link:<target>` (symlinks). */
export type Manifest = Record<string, string>;

export interface ManifestDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

/** What the proxy remembers about a `dir` between launches. */
export interface SyncRecord {
  dir: string;
  version: string | null;
  manifest: Manifest;
}

export interface RestoreResult {
  outcome: RestoreOutcome;
  /** What the remote archive holds as far as we know; changes are counted against it. */
  baseline: Manifest;
  /** Files in `dir` after the restore. */
  files: number;
}

/** The sync records' directory, directly in `workspace_root` (never inside a session dir). */
export const SYNC_DIR = ".carrier-sync";

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
  if (rel.split(/[\\/]/)[0] === SYNC_DIR) return `config.workspace.dir must not lie inside ${SYNC_DIR}`;
  const url = (k: string) => {
    const v = w[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" || !/^https?:\/\//.test(v)) throw new Error(`config.workspace.${k} must be an http(s) URL`);
    return v;
  };
  try {
    return {
      dir: resolve(w.dir),
      root: resolve(root),
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
 * Restore `dir` from `download_url`.
 *
 * An empty `dir` is filled from the archive ("restored"), or stays empty when
 * there is none yet ("empty"). A `dir` that already has files is the same
 * run's work (a relaunch after a dropped connection or a usage-limit pause):
 * it is "kept" — unless the sync record says it was last synced with an older
 * archive version than the one now in the store, i.e. another step uploaded
 * meanwhile; then its contents are "replaced" by that archive.
 */
export async function restoreWorkspace(ws: WorkspaceSync, tmpDir: string): Promise<RestoreResult> {
  const exclude = ws.exclude ?? [];
  if (existsSync(ws.dir) && readdirSync(ws.dir).length > 0) {
    const record = readSyncRecord(ws);
    const kept = (baseline: Manifest): RestoreResult => ({ outcome: "kept", baseline, files: Object.keys(buildManifest(ws.dir, exclude)).length });
    // No record: nothing to compare against; what is here is taken as synced.
    if (!record || !ws.download_url) return kept(record?.manifest ?? buildManifest(ws.dir, exclude));
    const res = await fetch(ws.download_url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
    // The archive is gone: everything here still has to be uploaded.
    if (res.status === 404) return kept({});
    if (!res.ok || !res.body) throw new Error(`GET workspace archive: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const version = remoteVersion(res);
    // Same archive as our last sync (or no way to tell): keep local edits; they
    // are still detected against the recorded manifest.
    if (!version || !record.version || version === record.version) {
      await res.body.cancel().catch(() => {});
      return kept(record.manifest);
    }
    const archive = await download(res, tmpDir);
    try {
      for (const name of readdirSync(ws.dir)) rmSync(join(ws.dir, name), { recursive: true, force: true });
      await tar(["-xzf", archive, "-C", ws.dir]);
    } finally {
      rmSync(archive, { force: true });
    }
    return synced(ws, version, "replaced");
  }
  mkdirSync(ws.dir, { recursive: true });
  if (!ws.download_url) return { outcome: "empty", baseline: {}, files: 0 };
  const res = await fetch(ws.download_url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
  // Nothing uploaded yet: the first step of a run starts empty.
  if (res.status === 404) return { outcome: "empty", baseline: {}, files: 0 };
  if (!res.ok || !res.body) throw new Error(`GET workspace archive: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const archive = await download(res, tmpDir);
  try {
    await tar(["-xzf", archive, "-C", ws.dir]);
  } finally {
    rmSync(archive, { force: true });
  }
  return synced(ws, remoteVersion(res), "restored");
}

/** Archive `dir` and PUT it to `upload_url`; resolves the archive size and the stored version. */
export async function persistWorkspace(ws: WorkspaceSync, tmpDir: string): Promise<{ bytes: number; version: string | null }> {
  if (!ws.upload_url) return { bytes: 0, version: null };
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
    return { bytes: body.size, version: remoteVersion(res) };
  } finally {
    rmSync(archive, { force: true });
  }
}

/** The archive's version from a GET/PUT response: GCS generation, else the ETag. */
function remoteVersion(res: Response): string | null {
  return res.headers.get("x-goog-generation") ?? res.headers.get("etag") ?? null;
}

async function download(res: Response, tmpDir: string): Promise<string> {
  mkdirSync(tmpDir, { recursive: true });
  const archive = join(tmpDir, "workspace-download.tar.gz");
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(archive));
  } catch (e) {
    rmSync(archive, { force: true });
    throw e;
  }
  return archive;
}

/** After extracting `version`: record it and its manifest. */
function synced(ws: WorkspaceSync, version: string | null, outcome: RestoreOutcome): RestoreResult {
  const manifest = buildManifest(ws.dir, ws.exclude ?? []);
  writeSyncRecord(ws, { dir: ws.dir, version, manifest });
  return { outcome, baseline: manifest, files: Object.keys(manifest).length };
}

// ── change detection ───────────────────────────────────────────────────────

/** Walk `dir`: regular files and symlinks (not followed), minus `exclude` matches. */
export function buildManifest(dir: string, exclude: string[] = []): Manifest {
  const matchers = exclude.map(globToRegExp);
  const excluded = (rel: string) => matchers.some((re) => re.test(rel) || rel.split("/").some((part) => re.test(part)));
  const out: Manifest = {};
  const walk = (abs: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (excluded(r)) continue;
      const p = join(abs, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue; // removed while we walked
      }
      if (st.isSymbolicLink()) {
        try {
          out[r] = `link:${readlinkSync(p)}`;
        } catch {
          /* removed while we walked */
        }
      } else if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) out[r] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(dir, "");
  return out;
}

/** What changed from `before` to `after`; each list sorted. */
export function diffManifests(before: Manifest, after: Manifest): ManifestDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) added.push(k);
    else if (before[k] !== v) modified.push(k);
  }
  for (const k of Object.keys(before)) if (!(k in after)) deleted.push(k);
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

/** A tar-style `--exclude` glob: `**` any path, `*` any run within a component, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let src = "";
  const g = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      src += ".*";
      i++;
    } else if (c === "*") src += "[^/]*";
    else if (c === "?") src += "[^/]";
    else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}$`);
}

// ── sync record ────────────────────────────────────────────────────────────

/** `<workspace_root>/.carrier-sync/<sha256(dir) first 16 hex>.json`; null without a root. */
export function syncRecordPath(ws: WorkspaceSync): string | null {
  if (!ws.root) return null;
  const key = createHash("sha256").update(ws.dir).digest("hex").slice(0, 16);
  return join(ws.root, SYNC_DIR, `${key}.json`);
}

export function readSyncRecord(ws: WorkspaceSync): SyncRecord | null {
  const file = syncRecordPath(ws);
  if (!file || !existsSync(file)) return null;
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as SyncRecord;
    if (r.dir !== ws.dir || !r.manifest || typeof r.manifest !== "object") return null;
    return { dir: r.dir, version: typeof r.version === "string" ? r.version : null, manifest: r.manifest };
  } catch {
    return null;
  }
}

/** Write the record atomically (tmp file + rename). */
export function writeSyncRecord(ws: WorkspaceSync, record: SyncRecord): void {
  const file = syncRecordPath(ws);
  if (!file) return;
  mkdirSync(join(ws.root!, SYNC_DIR), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, file);
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
