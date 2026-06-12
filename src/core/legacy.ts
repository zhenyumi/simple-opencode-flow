/**
 * Legacy agent detection and migration via exact SHA-256 matching.
 *
 * Frozen hashes cover 9 legacy filenames (without sof- prefix).
 * Hash mismatch = conflict (not eligible).
 * --force skips mismatched files (does NOT delete them).
 */

import { readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { computeHash } from "./agents.js";

/** Result of detecting a single legacy agent file. */
export interface LegacyDetection {
  /** Original filename found on disk (without sof- prefix) */
  oldFilename: string;
  /** Expected new filename (with sof- prefix, or flow.md unchanged) */
  expectedNewName: string;
  /** Whether the computed hash matches the frozen hash */
  matched: boolean;
  /** SHA-256 from the frozen hash map */
  expectedHash: string;
  /** SHA-256 computed from the file on disk */
  computedHash: string;
  /** True if filename matched but hash did not */
  conflict: boolean;
}

/** Result of migrating a single legacy agent. */
export interface MigrationResult {
  /** Original filename */
  oldFilename: string;
  /** New filename after rename (or same if not renamed) */
  newFilename: string;
  /** Whether the file was actually renamed */
  renamed: boolean;
  /** Whether the file was skipped due to hash mismatch */
  skipped: boolean;
  /** Reason for skipping, if applicable */
  skipReason?: string;
}

/**
 * 9 frozen SHA-256 hashes for legacy agent detection.
 * Maps old filename (without sof- prefix) to its SHA-256 hex digest.
 * These are immutable; any change requires a new plan revision.
 */
export const LEGACY_HASHES: ReadonlyMap<string, string> = new Map([
  ["flow.md", "0f8e368919a78a402d19646562cc89c0b59fe22155392c35d3dbbb128fb9825f"],
  ["explore-repository.md", "36eeb73ace40008182ae22e420168f011f47ee9fd09e97a57150d357c213efd6"],
  ["design-change.md", "6a8dc9af8dbb6965fc46f07ff65da2ab3739f406c832756e12aca1c965d18607"],
  ["write-plan.md", "de39e3acef32763dc0be4831a961c67f1a50cefbc93905705e28230f866484e2"],
  ["review-plan.md", "a5f5d5d27d44955f7adeebb461c68f27d2cf207cac1b25307169f1f6ac7da192"],
  ["implement-task.md", "1f4a9f01738079e588e1bc94438c2686219015c6b7e45d845cf52b2b02e896ee"],
  ["review-code.md", "053f53d7a918491b2bfae08b62637c34a6ea12146b20969aad2424633a42baa6"],
  ["verify-release.md", "868017e83a593bbdea54f9a0fcb4a6fd784c915549ca51c7384b78e74e5c64a2"],
  ["audit-release.md", "9a3d8f6b0a484a67f6dc314b10ed1861ac7738e2313c9ef9c2d83e8671a0b494"],
]);

/**
 * Computes the expected new name for a legacy filename.
 * flow.md stays as flow.md; all others get sof- prefix.
 */
function expectedNewName(oldFilename: string): string {
  if (oldFilename === "flow.md") return "flow.md";
  return `sof-${oldFilename}`;
}

/**
 * Scans agentsDir for legacy agent files (matching LEGACY_HASHES keys).
 * For each match, computes SHA-256 and compares against the frozen hash.
 *
 * @param agentsDir - Directory to scan for legacy agent files
 * @returns Array of detections (only files found on disk that match legacy names)
 */
export async function detectLegacyAgents(
  agentsDir: string
): Promise<LegacyDetection[]> {
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    // Directory doesn't exist → no legacy agents
    return [];
  }

  const detections: LegacyDetection[] = [];

  for (const entry of entries) {
    const expectedHash = LEGACY_HASHES.get(entry);
    if (!expectedHash) continue; // Not a legacy filename

    const filePath = join(agentsDir, entry);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) continue;

    const computedHash = await computeHash(filePath);
    const matched = computedHash === expectedHash;

    detections.push({
      oldFilename: entry,
      expectedNewName: expectedNewName(entry),
      matched,
      expectedHash,
      computedHash,
      conflict: !matched,
    });
  }

  return detections;
}

/**
 * Determines whether migration is allowed based on detections and --force flag.
 *
 * Rules:
 * - If any conflict and NOT force → not allowed
 * - If any conflict and force → allowed (conflicts will be skipped)
 * - If all matched → allowed
 * - If no detections → allowed (nothing to do)
 */
export function isMigrationAllowed(
  detections: LegacyDetection[],
  force: boolean
): { allowed: boolean; conflicts: LegacyDetection[] } {
  const conflicts = detections.filter((d) => d.conflict);

  if (conflicts.length > 0 && !force) {
    return { allowed: false, conflicts };
  }

  return { allowed: true, conflicts };
}

/**
 * Migrates legacy agents by renaming matched files to sof- prefixed names.
 * Hash-mismatched files are skipped (NOT deleted, NOT renamed).
 *
 * @param agentsDir - Directory containing legacy agent files
 * @param detections - Detection results from detectLegacyAgents
 * @returns Array of migration results
 */
export async function migrateLegacyAgents(
  agentsDir: string,
  detections: LegacyDetection[]
): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];

  for (const detection of detections) {
    if (detection.conflict) {
      results.push({
        oldFilename: detection.oldFilename,
        newFilename: detection.oldFilename,
        renamed: false,
        skipped: true,
        skipReason: "hash mismatch — file preserved",
      });
      continue;
    }

    // Matched: rename old → new
    const oldPath = join(agentsDir, detection.oldFilename);
    const newPath = join(agentsDir, detection.expectedNewName);

    // If flow.md, it stays as flow.md — no rename needed
    if (detection.oldFilename === detection.expectedNewName) {
      results.push({
        oldFilename: detection.oldFilename,
        newFilename: detection.expectedNewName,
        renamed: false,
        skipped: false,
      });
      continue;
    }

    await rename(oldPath, newPath);
    results.push({
      oldFilename: detection.oldFilename,
      newFilename: detection.expectedNewName,
      renamed: true,
      skipped: false,
    });
  }

  return results;
}
