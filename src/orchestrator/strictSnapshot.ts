import { createHash } from "node:crypto";
import { STRICT_SNAPSHOT_FORMAT_VERSION, StrictBaselineIdentity, StrictSnapshotEntry } from "../shared/strict";

const ENTRY_KEYS = [
  "path", "kind", "status", "beforeMode", "afterMode", "beforeSize", "afterSize", "beforeHash", "afterHash",
] as const;

export interface StrictSnapshotManifestInput {
  baseline: StrictBaselineIdentity;
  /** Reviewable in-perimeter changes only; policy exclusions never enter the digest. */
  entries: StrictSnapshotEntry[];
}

/**
 * The canonical manifest the snapshot digest is taken over: format version, baseline
 * identity and digest, then entries sorted by relative POSIX path in UTF-8 bytes.
 *
 * Unlike the plan, nothing here is normalised. The bytes are the bytes on disk, so LF
 * and CRLF give different digests and a whitespace-only edit still invalidates approvals.
 */
export function canonicalStrictSnapshotManifest(input: StrictSnapshotManifestInput): string {
  const entries = [...input.entries]
    .sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")))
    .map((entry) => {
      const ordered: Record<string, unknown> = {};
      for (const key of ENTRY_KEYS) {
        const value = entry[key];
        if (value !== undefined) ordered[key] = value;
      }
      return ordered;
    });
  return JSON.stringify({
    formatVersion: STRICT_SNAPSHOT_FORMAT_VERSION,
    baseline: {
      root: input.baseline.root,
      source: input.baseline.source,
      digest: input.baseline.digest,
      entryCount: input.baseline.entryCount,
      ...(input.baseline.git ? { git: { repository: input.baseline.git.repository, head: input.baseline.git.head ?? null } } : {}),
    },
    entries,
  });
}

export function strictSnapshotDigest(input: StrictSnapshotManifestInput): string {
  return createHash("sha256").update(canonicalStrictSnapshotManifest(input), "utf8").digest("hex");
}

export function strictBaselineDigest(entries: { path: string; kind: string; size: number; hash?: string; mtimeMs?: number }[]): string {
  const canonical = JSON.stringify([...entries]
    .sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")))
    .map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
      ...(entry.hash === undefined ? {} : { hash: entry.hash }),
      ...(entry.hash === undefined && entry.mtimeMs !== undefined ? { mtimeMs: entry.mtimeMs } : {}),
    })));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
