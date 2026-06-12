import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

export const MANIFEST_FILENAME = ".sof-manifest.json";
export const MANIFEST_SCHEMA_VERSION = "1.0";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConfigRuleEntry {
  /** e.g. "agent.build.permission.task" */
  targetPath: string;
  /** e.g. "sof-*" or "flow" */
  ruleKey: string;
  /** e.g. "deny" */
  ruleValue: string;
  /** Whether the rule existed before the installer wrote it */
  existedBefore: boolean;
  /** Previous value if the rule existed before */
  previousValue: string | null;
  /** Previous ordered position if the rule existed before */
  previousOrderedPosition: number | null;
  /** What action the installer took */
  action: "inserted" | "changed" | "reordered";
  /** The value the installer last wrote */
  lastWrittenValue: string;
  /** The position the installer last wrote the rule at */
  lastWrittenOrderedPosition: number | null;
  /** Whether the rule was moved to end for position safety (C-018) */
  reordered: boolean;
  /** Original index before reorder */
  originalPosition: number | null;
  /** Index after reorder */
  newPosition: number | null;
}

/** Ordered array of [key, value] entries for semantic comparison preserving rule order */
export type TaskPolicySnapshot = Array<[string, string]>;

export interface ScalarConversion {
  /** The original scalar Task value when scalar-to-object conversion was performed (e.g. "allow"); null if no conversion */
  originalValue: string | null;
}

export interface ManifestEntry {
  agentName: string;
  installedPath: string;
  sourceHash: string;
  installedAt: string;
  managedBy: string;
  configRules: ConfigRuleEntry[];
  scalarConversion: ScalarConversion | null;
  createdAncestors: string[];
  createdConfigFile: string | null;
  initialConfigState: object | null;
  configPath: string;
  lastWrittenStateFingerprint: string;
  manifestSchemaVersion: string;
  installerVersion: string;
}

export interface Manifest {
  version: string;
  entries: Record<string, ManifestEntry>;
  /** Last-written Task policy snapshots keyed by configPath for semantic comparison */
  lastWrittenTaskSnapshots: Record<string, TaskPolicySnapshot>;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function manifestPath(scopeDir: string): string {
  return join(scopeDir, ".opencode", MANIFEST_FILENAME);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Read and validate the manifest from disk.
 * Returns null if the file does not exist.
 * Throws if the file is corrupt or has an incompatible schema version.
 */
export async function readManifest(scopeDir: string): Promise<Manifest | null> {
  const filePath = manifestPath(scopeDir);
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Corrupt manifest at ${filePath}: invalid JSON`);
  }

  const validation = validateManifest(parsed);
  if (!validation.valid) {
    throw new Error(
      `Invalid manifest at ${filePath}: ${validation.errors.join("; ")}`
    );
  }

  return parsed as Manifest;
}

/**
 * Create an empty v1.0 manifest.
 */
export function createManifest(
  _scopeDir: string,
  _installerVersion: string
): Manifest {
  return {
    version: MANIFEST_SCHEMA_VERSION,
    entries: {},
    lastWrittenTaskSnapshots: {},
  };
}

/**
 * Add or update an agent entry in the manifest.
 */
export function addAgentEntry(
  manifest: Manifest,
  agentName: string,
  entry: ManifestEntry
): Manifest {
  return {
    ...manifest,
    entries: { ...manifest.entries, [agentName]: entry },
  };
}

/**
 * Add or update a config rule entry identified by composite key (targetPath + ruleKey).
 * If an entry with the same composite key exists, it is replaced.
 */
export function addConfigRuleEntry(
  manifest: Manifest,
  agentName: string,
  rule: ConfigRuleEntry
): Manifest {
  const entry = manifest.entries[agentName];
  if (!entry) {
    throw new Error(`Agent entry not found: ${agentName}`);
  }

  const existingIndex = entry.configRules.findIndex(
    (r) => r.targetPath === rule.targetPath && r.ruleKey === rule.ruleKey
  );

  let newRules: ConfigRuleEntry[];
  if (existingIndex >= 0) {
    newRules = [...entry.configRules];
    newRules[existingIndex] = rule;
  } else {
    newRules = [...entry.configRules, rule];
  }

  return {
    ...manifest,
    entries: {
      ...manifest.entries,
      [agentName]: { ...entry, configRules: newRules },
    },
  };
}

/**
 * Remove an agent entry from the manifest.
 */
export function removeAgentEntry(
  manifest: Manifest,
  agentName: string
): Manifest {
  const newEntries = { ...manifest.entries };
  delete newEntries[agentName];
  return { ...manifest, entries: newEntries };
}

/**
 * Retrieve the last-written Task policy snapshot for semantic comparison.
 * Returns null if no snapshot exists for the given configPath.
 */
export function getLastWrittenTaskSnapshot(
  manifest: Manifest,
  configPath: string
): TaskPolicySnapshot | null {
  return manifest.lastWrittenTaskSnapshots[configPath] ?? null;
}

/**
 * Semantic ordered comparison of a current Task policy snapshot against
 * the manifest's last-written snapshot for the given configPath.
 */
export function compareTaskSnapshot(
  manifest: Manifest,
  configPath: string,
  currentSnapshot: TaskPolicySnapshot
): { identical: boolean; differences: string[] } {
  const lastWritten = manifest.lastWrittenTaskSnapshots[configPath];
  if (!lastWritten) {
    return {
      identical: false,
      differences: ["No last-written snapshot found for configPath"],
    };
  }

  const differences: string[] = [];

  if (lastWritten.length !== currentSnapshot.length) {
    differences.push(
      `Length mismatch: last-written has ${lastWritten.length} entries, current has ${currentSnapshot.length}`
    );
  }

  const maxLen = Math.max(lastWritten.length, currentSnapshot.length);
  for (let i = 0; i < maxLen; i++) {
    const lw = lastWritten[i];
    const cu = currentSnapshot[i];
    if (!lw) {
      differences.push(
        `Extra entry at position ${i}: ["${cu[0]}", "${cu[1]}"]`
      );
    } else if (!cu) {
      differences.push(
        `Missing entry at position ${i}: ["${lw[0]}", "${lw[1]}"]`
      );
    } else if (lw[0] !== cu[0] || lw[1] !== cu[1]) {
      differences.push(
        `Entry at position ${i}: last-written ["${lw[0]}", "${lw[1]}"] vs current ["${cu[0]}", "${cu[1]}"]`
      );
    }
  }

  return { identical: differences.length === 0, differences };
}

/**
 * Check if an agent is sof-managed (present in manifest entries).
 */
export function isManaged(manifest: Manifest, agentName: string): boolean {
  return agentName in manifest.entries;
}

/**
 * Check if a specific config rule (identified by composite key targetPath + ruleKey)
 * is installer-owned.
 */
export function isConfigRuleManaged(
  manifest: Manifest,
  targetPath: string,
  ruleKey: string
): boolean {
  for (const entry of Object.values(manifest.entries)) {
    if (
      entry.configRules.some(
        (r) => r.targetPath === targetPath && r.ruleKey === ruleKey
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Validate manifest structure: schema version, required fields, format.
 */
export function validateManifest(manifest: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== "object") {
    errors.push("Manifest must be a non-null object");
    return { valid: false, errors };
  }

  const m = manifest as Record<string, unknown>;

  if (m.version !== MANIFEST_SCHEMA_VERSION) {
    errors.push(
      `Incompatible schema version: ${String(m.version)} (expected ${MANIFEST_SCHEMA_VERSION})`
    );
  }

  if (!m.entries || typeof m.entries !== "object") {
    errors.push("Missing or invalid entries field");
  }

  if (!m.lastWrittenTaskSnapshots || typeof m.lastWrittenTaskSnapshots !== "object") {
    errors.push("Missing or invalid lastWrittenTaskSnapshots field");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Write the manifest to disk as formatted JSON.
 */
export async function writeManifest(
  scopeDir: string,
  manifest: Manifest
): Promise<void> {
  const filePath = manifestPath(scopeDir);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/**
 * Compute SHA-256 fingerprint of relevant config sections.
 * Reads the config file and hashes its full content for deterministic fingerprinting.
 */
export async function computeConfigFingerprint(
  configPath: string,
  _relevantPaths: string[]
): Promise<string> {
  const content = await readFile(configPath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}
