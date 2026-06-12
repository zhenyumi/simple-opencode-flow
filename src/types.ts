// Shared TypeScript interfaces for the sof CLI installer.
// Composite primary key for ConfigRuleEntry: targetPath + ruleKey.

/** Agent YAML frontmatter metadata. */
export interface AgentMetadata {
  name: string;
  description: string;
  mode: 'primary' | 'subagent';
  temperature: number;
}

/** Action performed on a config rule entry. */
export type ConfigRuleAction = 'inserted' | 'changed' | 'reordered';

/**
 * Per-rule config ownership entry.
 * Composite primary key: targetPath + ruleKey (e.g., "agent.build.permission.task" + "sof-*").
 * Tracks 4 managed deny rules: Build sof-*, Build flow, Plan sof-*, Plan flow.
 */
export interface ConfigRuleEntry {
  /** Config path, e.g., "agent.build.permission.task" */
  targetPath: string;
  /** Rule key, e.g., "sof-*" or "flow" */
  ruleKey: string;
  /** Rule value, e.g., "deny" */
  ruleValue: string;
  /** Whether the rule existed before installer touched it */
  existedBefore: boolean;
  /** Previous value if the rule existed */
  previousValue: string | null;
  /** Previous ordered position if the rule existed */
  previousOrderedPosition: number | null;
  /** Action performed: inserted, changed, or reordered */
  action: ConfigRuleAction;
  /** Last value written by the installer */
  lastWrittenValue: string;
  /** Last ordered position written by the installer */
  lastWrittenOrderedPosition: number | null;
  /** Whether the rule was moved to end for position safety (C-018) */
  reordered: boolean;
  /** Original index before reorder, null if not reordered */
  originalPosition: number | null;
  /** Index after reorder, null if not reordered */
  newPosition: number | null;
}

/**
 * Ordered array of [key, value] entries for semantic comparison preserving rule order.
 * Used for Task policy snapshot comparison.
 */
export type TaskPolicySnapshot = Array<[string, string]>;

/** Original scalar value stored when scalar-to-object conversion was performed. */
export interface ScalarConversion {
  /** Original scalar value, e.g., "allow". Null if no conversion occurred. */
  originalValue: string | null;
}

/**
 * Per-agent manifest entry tracking both agent files and config ownership.
 */
export interface ManifestEntry {
  /** Agent name, e.g., "sof-explore-repository" */
  agentName: string;
  /** Installed file path, e.g., "~/.config/opencode/agents/sof-explore-repository.md" */
  installedPath: string;
  /** SHA-256 hex of the installed agent file */
  sourceHash: string;
  /** ISO 8601 timestamp of installation */
  installedAt: string;
  /** Manager identifier, e.g., "sof" */
  managedBy: string;
  /** Config rules owned by this agent installation */
  configRules: ConfigRuleEntry[];
  /** Records original scalar Task value when scalar-to-object conversion was performed */
  scalarConversion: ScalarConversion | null;
  /** Ancestor directories created by the installer */
  createdAncestors: string[];
  /** Config file created by the installer (null if file pre-existed) */
  createdConfigFile: string | null;
  /** Initial config file state if installer created it */
  initialConfigState: object | null;
  /** Path to the config file that was patched */
  configPath: string;
  /** SHA-256 fingerprint of relevant config sections at last write */
  lastWrittenStateFingerprint: string;
  /** Manifest schema version, e.g., "1.0" */
  manifestSchemaVersion: string;
  /** Installer version from package.json */
  installerVersion: string;
}

/** Top-level manifest structure. */
export interface Manifest {
  /** Manifest schema version */
  version: string;
  /** Agent entries keyed by agent name */
  entries: Record<string, ManifestEntry>;
  /** Last-written Task policy snapshots keyed by configPath for semantic comparison */
  lastWrittenTaskSnapshots: Record<string, TaskPolicySnapshot>;
}

/** Options for the install command. */
export interface InstallOptions {
  projectDir?: string;
  global?: boolean;
  force?: boolean;
  dryRun?: boolean;
  migrateLegacy?: boolean;
}

/** Options for the update command. */
export interface UpdateOptions {
  projectDir?: string;
  global?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

/** Options for the uninstall command. */
export interface UninstallOptions {
  projectDir?: string;
  global?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

/** Options for the doctor command. */
export interface DoctorOptions {
  projectDir?: string;
  global?: boolean;
  runtime?: boolean;
}

/** Target for a config patch operation. */
export interface ConfigPatchTarget {
  /** Dot-separated path, e.g., "agent.build.permission.task" */
  path: string;
  /** Key to insert/change, e.g., "sof-*" */
  key: string;
  /** Value to set, e.g., "deny" */
  value: string;
}

/** Type of planned operation. */
export type PlannedOperationType = 'backup' | 'write' | 'delete' | 'rename';

/** A single planned file operation. */
export interface PlannedOperation {
  type: PlannedOperationType;
  sourcePath: string;
  destPath?: string;
  content?: string | Buffer;
}

/** Result of preflight analysis. */
export interface PreflightReport {
  orderedOperations: PlannedOperation[];
  conflicts: string[];
  backups: string[];
  wouldSucceed: boolean;
}
