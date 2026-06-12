// sof uninstall command: safely remove managed agents and installer-owned config.
// Ordering: agents before protection (C-014), manifest last.
// Scalar restore: only when exact match (AC-07).
// User data preservation: always (C-015, R-006).

import { readFile, readdir, stat, rm } from "node:fs/promises";
import { join, dirname, basename, relative } from "node:path";
import { createHash } from "node:crypto";
import { resolveScope, type ScopeResult } from "../core/project-root.js";
import {
  readManifest,
  writeManifest,
  getLastWrittenTaskSnapshot,
  compareTaskSnapshot,
  type Manifest,
  type ManifestEntry,
  type ConfigRuleEntry,
  type TaskPolicySnapshot,
} from "../core/manifest.js";
import {
  readConfigParseTree,
  findTaskNode,
  validateNoDuplicateKeys,
  validateAncestorsCompatible,
  writePatchedConfig,
  type ConfigParseTree,
} from "../core/config.js";
import {
  performPreflight,
  createBackupDir,
  backupFile,
  executeUninstall,
} from "../core/operations.js";
import type {
  UninstallOptions,
  PreflightReport,
  PlannedOperation as PlannedOperationType,
} from "../types.js";
import { getNodeValue, modify, applyEdits } from "jsonc-parser";

// ─── Types ──────────────────────────────────────────────────────────────────

interface UninstallPreflightResult {
  agentDeleteOps: PlannedOperationType[];
  configWriteOps: PlannedOperationType[];
  manifestDeleteOp: PlannedOperationType | null;
  ancestorDeleteOps: PlannedOperationType[];
  configFileDeleteOp: PlannedOperationType | null;
  conflicts: string[];
  skippedRules: Array<{ targetPath: string; ruleKey: string; reason: string }>;
  scalarRestore: { configPath: string; originalValue: string } | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectoryEmpty(dirPath: string): Promise<boolean> {
  try {
    const entries = await readdir(dirPath);
    return entries.length === 0;
  } catch {
    return false;
  }
}

/**
 * Extract the Task policy as an ordered snapshot from the parse tree.
 */
function extractTaskSnapshot(
  tree: ConfigParseTree,
  pathSegments: string[]
): TaskPolicySnapshot | null {
  const taskNode = findTaskNode(tree, pathSegments);
  if (!taskNode) return null;

  if (taskNode.type === "string") {
    // Scalar Task
    return [["*", taskNode.value as string]];
  }

  if (taskNode.type !== "object") return null;

  const snapshot: TaskPolicySnapshot = [];
  if (taskNode.children) {
    for (const child of taskNode.children) {
      if (child.type === "property" && child.children && child.children[0] && child.children[1]) {
        const key = child.children[0].value as string;
        const value = child.children[1].value as string;
        if (key !== undefined && value !== undefined) {
          snapshot.push([key, value]);
        }
      }
    }
  }

  return snapshot;
}

/**
 * Check if a config rule matches its manifest last-written state.
 */
function ruleMatchesLastWritten(
  currentTree: ConfigParseTree,
  rule: ConfigRuleEntry
): boolean {
  const pathSegments = rule.targetPath.split(".");
  const taskNode = findTaskNode(currentTree, pathSegments);
  if (!taskNode || taskNode.type !== "object") return false;

  const properties = taskNode.children ?? [];
  for (const prop of properties) {
    if (prop.type === "property" && prop.children && prop.children[0] && prop.children[1]) {
      const key = prop.children[0].value as string;
      const value = prop.children[1].value as string;
      if (key === rule.ruleKey) {
        return value === rule.lastWrittenValue;
      }
    }
  }

  // Rule not found - only matches if it wasn't supposed to exist
  return false;
}

/**
 * Remove a specific rule from the Task object in the config tree.
 * Returns true if the rule was found and removed.
 */
function removeRuleFromTask(
  tree: ConfigParseTree,
  targetPath: string,
  ruleKey: string
): boolean {
  const pathSegments = targetPath.split(".");
  const taskNode = findTaskNode(tree, pathSegments);
  if (!taskNode || taskNode.type !== "object") return false;

  const properties = taskNode.children ?? [];
  for (const prop of properties) {
    if (prop.type === "property" && prop.children && prop.children[0]) {
      const key = prop.children[0].value as string;
      if (key === ruleKey) {
        const edits = modify(tree.text, [...pathSegments, ruleKey], undefined, {});
        tree.text = applyEdits(tree.text, edits);
        return true;
      }
    }
  }

  return false;
}

/**
 * Restore a scalar Task value from an object representation.
 */
function restoreScalarTask(
  tree: ConfigParseTree,
  targetPath: string,
  scalarValue: string
): void {
  const pathSegments = targetPath.split(".");
  const edits = modify(tree.text, pathSegments, scalarValue, {});
  tree.text = applyEdits(tree.text, edits);
}

/**
 * Collect all unique config paths from manifest entries.
 */
function collectConfigPaths(manifest: Manifest): string[] {
  const paths = new Set<string>();
  for (const entry of Object.values(manifest.entries)) {
    if (entry.configPath) {
      paths.add(entry.configPath);
    }
  }
  return Array.from(paths);
}

/**
 * Collect all unique target paths from config rules across all entries.
 */
function collectTargetPaths(manifest: Manifest): string[] {
  const paths = new Set<string>();
  for (const entry of Object.values(manifest.entries)) {
    for (const rule of entry.configRules) {
      paths.add(rule.targetPath);
    }
  }
  return Array.from(paths);
}

// ─── Preflight ──────────────────────────────────────────────────────────────

/**
 * Perform complete read-only preflight for uninstall.
 * Returns planned operations, conflicts, and scalar restore info.
 */
async function performUninstallPreflight(
  scopeDir: string,
  scope: ScopeResult,
  manifest: Manifest,
  options: UninstallOptions
): Promise<UninstallPreflightResult> {
  const agentDeleteOps: PlannedOperationType[] = [];
  const configWriteOps: PlannedOperationType[] = [];
  const ancestorDeleteOps: PlannedOperationType[] = [];
  const conflicts: string[] = [];
  const skippedRules: UninstallPreflightResult["skippedRules"] = [];
  let scalarRestore: UninstallPreflightResult["scalarRestore"] = null;
  let configFileDeleteOp: PlannedOperationType | null = null;
  let manifestDeleteOp: PlannedOperationType | null = null;

  // 1. Identify managed agent files for deletion
  for (const [agentName, entry] of Object.entries(manifest.entries)) {
    const agentPath = join(scopeDir, entry.installedPath);
    if (await pathExists(agentPath)) {
      agentDeleteOps.push({
        type: "delete",
        sourcePath: agentPath,
      });
    }
  }

  // 2. Read config and check rules
  const configPaths = collectConfigPaths(manifest);
  for (const configPath of configPaths) {
    const absoluteConfigPath = join(scopeDir, configPath);

    if (!(await pathExists(absoluteConfigPath))) {
      // Config file doesn't exist - nothing to do for rules
      continue;
    }

    let tree: ConfigParseTree;
    try {
      tree = await readConfigParseTree(absoluteConfigPath);
    } catch (err: any) {
      conflicts.push(`Cannot parse config file ${configPath}: ${err.message}`);
      continue;
    }

    // Collect all rules from all entries
    const allRules: Array<{ rule: ConfigRuleEntry; entry: ManifestEntry }> = [];
    for (const entry of Object.values(manifest.entries)) {
      for (const rule of entry.configRules) {
        allRules.push({ rule, entry });
      }
    }

    // Check each managed rule
    for (const { rule } of allRules) {
      const pathSegments = rule.targetPath.split(".");
      const taskNode = findTaskNode(tree, pathSegments);

      if (!taskNode) {
        // Task node doesn't exist - rule already gone
        continue;
      }

      if (taskNode.type !== "object") {
        // Task is scalar - can't have individual rules
        continue;
      }

      // Find the rule in current config
      let currentRuleValue: string | undefined;
      const properties = taskNode.children ?? [];
      for (const prop of properties) {
        if (prop.type === "property" && prop.children && prop.children[0] && prop.children[1]) {
          const key = prop.children[0].value as string;
          const value = prop.children[1].value as string;
          if (key === rule.ruleKey) {
            currentRuleValue = value;
            break;
          }
        }
      }

      if (currentRuleValue === undefined) {
        // Rule not present - already removed
        continue;
      }

      if (currentRuleValue === rule.lastWrittenValue) {
        // Rule matches last-written state - safe to remove
        configWriteOps.push({
          type: "write",
          sourcePath: "",
          destPath: absoluteConfigPath,
          content: `__REMOVE_RULE__:${rule.targetPath}:${rule.ruleKey}`,
        });
      } else {
        // User modified the rule
        if (options.force) {
          // --force: remove anyway
          configWriteOps.push({
            type: "write",
            sourcePath: "",
            destPath: absoluteConfigPath,
            content: `__REMOVE_RULE__:${rule.targetPath}:${rule.ruleKey}`,
          });
        } else {
          skippedRules.push({
            targetPath: rule.targetPath,
            ruleKey: rule.ruleKey,
            reason: "User-modified (use --force to remove)",
          });
        }
      }
    }

    // 3. Check scalar restore
    const targetPaths = collectTargetPaths(manifest);
    for (const targetPath of targetPaths) {
      const pathSegments = targetPath.split(".");
      const taskNode = findTaskNode(tree, pathSegments);

      if (!taskNode || taskNode.type !== "object") continue;

      // Check if this Task object was converted from scalar
      let entryWithScalar: ManifestEntry | undefined;
      for (const entry of Object.values(manifest.entries)) {
        if (
          entry.scalarConversion &&
          entry.scalarConversion.originalValue !== null &&
          entry.configRules.some((r) => r.targetPath === targetPath)
        ) {
          entryWithScalar = entry;
          break;
        }
      }

      if (!entryWithScalar || !entryWithScalar.scalarConversion) continue;

      // Get the last-written snapshot
      const lastWrittenSnapshot = getLastWrittenTaskSnapshot(manifest, targetPath);
      if (!lastWrittenSnapshot) continue;

      // Extract current snapshot
      const currentSnapshot = extractTaskSnapshot(tree, pathSegments);
      if (!currentSnapshot) continue;

      // Compare semantically
      const comparison = compareTaskSnapshot(manifest, targetPath, currentSnapshot);
      if (comparison.identical) {
        // Exact match - safe to restore scalar
        scalarRestore = {
          configPath: absoluteConfigPath,
          originalValue: entryWithScalar.scalarConversion.originalValue!,
        };
      }
    }
  }

  // 4. Check installer-created ancestors
  for (const entry of Object.values(manifest.entries)) {
    for (const ancestor of entry.createdAncestors) {
      const ancestorPath = join(scopeDir, ancestor);
      if (await pathExists(ancestorPath)) {
        const empty = await isDirectoryEmpty(ancestorPath);
        if (empty) {
          ancestorDeleteOps.push({
            type: "delete",
            sourcePath: ancestorPath,
          });
        }
        // If not empty, user added content - preserve
      }
    }
  }

  // 5. Check installer-created config file
  for (const entry of Object.values(manifest.entries)) {
    if (entry.createdConfigFile && entry.initialConfigState) {
      const configFilePath = join(scopeDir, entry.createdConfigFile);
      if (await pathExists(configFilePath)) {
        try {
          const content = await readFile(configFilePath, "utf-8");
          const parsed = JSON.parse(content);
          const initialState = entry.initialConfigState as Record<string, unknown>;

          // Check if config is at initial state (only installer content)
          if (JSON.stringify(parsed) === JSON.stringify(initialState)) {
            configFileDeleteOp = {
              type: "delete",
              sourcePath: configFilePath,
            };
          }
          // Otherwise user added content - preserve
        } catch {
          // Can't parse - preserve
        }
      }
    }
  }

  // 6. Manifest deletion (last operation)
  const manifestPath = join(scopeDir, ".opencode", ".sof-manifest.json");
  if (await pathExists(manifestPath)) {
    manifestDeleteOp = {
      type: "delete",
      sourcePath: manifestPath,
    };
  }

  return {
    agentDeleteOps,
    configWriteOps,
    manifestDeleteOp,
    ancestorDeleteOps,
    configFileDeleteOp,
    conflicts,
    skippedRules,
    scalarRestore,
  };
}

// ─── Execution ──────────────────────────────────────────────────────────────

/**
 * Execute the uninstall with proper ordering:
 * 1. Backup files
 * 2. Remove agents (FIRST - C-014)
 * 3. Remove/restore config rules
 * 4. Scalar restore if applicable
 * 5. Remove empty ancestors
 * 6. Delete installer-created config if at initial state
 * 7. Delete manifest (LAST)
 */
async function executeUninstallSteps(
  scopeDir: string,
  scope: ScopeResult,
  manifest: Manifest,
  preflight: UninstallPreflightResult,
  backupDir: string
): Promise<void> {
  const backedUpPaths: string[] = [];
  const createdFiles: string[] = [];

  try {
    // 1. Backup agent files before deletion
    for (const op of preflight.agentDeleteOps) {
      await backupFile(backupDir, op.sourcePath);
      backedUpPaths.push(op.sourcePath);
    }

    // 2. Backup config file if we're going to modify it
    const configPaths = collectConfigPaths(manifest);
    for (const configPath of configPaths) {
      const absoluteConfigPath = join(scopeDir, configPath);
      if (await pathExists(absoluteConfigPath)) {
        await backupFile(backupDir, absoluteConfigPath);
        backedUpPaths.push(absoluteConfigPath);
      }
    }

    // 3. Remove agents FIRST (C-014)
    for (const op of preflight.agentDeleteOps) {
      await rm(op.sourcePath, { force: true });
    }

    // 4. Remove/restore config rules
    // Group rule removals by config file
    const rulesByConfig = new Map<string, Array<{ targetPath: string; ruleKey: string }>>();
    for (const op of preflight.configWriteOps) {
      const content = op.content as string;
      if (content.startsWith("__REMOVE_RULE__:")) {
        const parts = content.split(":");
        const targetPath = parts[1];
        const ruleKey = parts[2];
        const configPath = op.destPath!;

        if (!rulesByConfig.has(configPath)) {
          rulesByConfig.set(configPath, []);
        }
        rulesByConfig.get(configPath)!.push({ targetPath, ruleKey });
      }
    }

    // Process each config file
    for (const [configPath, rules] of rulesByConfig) {
      if (!(await pathExists(configPath))) continue;

      const tree = await readConfigParseTree(configPath);

      // Remove each rule
      for (const { targetPath, ruleKey } of rules) {
        removeRuleFromTask(tree, targetPath, ruleKey);
      }

      // 5. Scalar restore if applicable
      if (
        preflight.scalarRestore &&
        preflight.scalarRestore.configPath === configPath
      ) {
        // Find the target path for scalar restore
        const targetPaths = collectTargetPaths(manifest);
        for (const targetPath of targetPaths) {
          const pathSegments = targetPath.split(".");
          const taskNode = findTaskNode(tree, pathSegments);
          if (taskNode && taskNode.type === "object") {
            restoreScalarTask(tree, targetPath, preflight.scalarRestore.originalValue);
            break;
          }
        }
      }

      await writePatchedConfig(configPath, tree);
    }

    // 6. Remove empty ancestors
    // Collect all created ancestors from manifest (may include ones preflight didn't flag)
    const allAncestors = new Set<string>();
    for (const entry of Object.values(manifest.entries)) {
      for (const ancestor of entry.createdAncestors) {
        allAncestors.add(join(scopeDir, ancestor));
      }
    }
    // Process ancestors in reverse order (deepest first)
    const sortedAncestors = Array.from(allAncestors).sort((a, b) => b.length - a.length);
    for (const ancestorPath of sortedAncestors) {
      if (await pathExists(ancestorPath)) {
        const empty = await isDirectoryEmpty(ancestorPath);
        if (empty) {
          await rm(ancestorPath, { recursive: true });
        }
      }
    }

    // 7. Delete installer-created config if at initial state
    // Use the preflight decision (checked before rules were removed)
    if (preflight.configFileDeleteOp) {
      const configFilePath = preflight.configFileDeleteOp.sourcePath;
      if (await pathExists(configFilePath)) {
        await rm(configFilePath, { force: true });
      }
    }

    // 8. Delete manifest LAST
    if (preflight.manifestDeleteOp) {
      await rm(preflight.manifestDeleteOp.sourcePath, { force: true });
    }
  } catch (err) {
    // Best-effort rollback
    console.error("Uninstall failed, attempting rollback...");

    // Restore backed-up files
    for (const originalPath of backedUpPaths) {
      try {
        const backupPath = join(backupDir, basename(originalPath));
        if (await pathExists(backupPath)) {
          const content = await readFile(backupPath);
          const { writeFile } = await import("node:fs/promises");
          await writeFile(originalPath, content);
        }
      } catch (rollbackErr) {
        console.error(`Rollback failed for ${originalPath}:`, rollbackErr);
      }
    }

    // Delete newly created files
    for (const file of createdFiles) {
      try {
        await rm(file, { force: true });
      } catch {
        // Best-effort
      }
    }

    throw err;
  }
}

// ─── Main Command ───────────────────────────────────────────────────────────

/**
 * Execute `sof uninstall` command.
 *
 * Flow:
 * 1. Resolve scope
 * 2. Read manifest; block if missing/corrupt/incompatible
 * 3. Perform complete preflight (read-only)
 * 4. If --dry-run: report, exit 0, zero writes
 * 5. Create backup directory
 * 6. Remove managed agents FIRST (agents before protection - C-014)
 * 7. Remove/restore config rules (only unchanged installer-owned)
 * 8. Scalar restore: only when entire Task object matches manifest last-written state
 * 9. Remove installer-created ancestors when empty
 * 10. Delete installer-created config when empty/initial state
 * 11. Delete manifest LAST
 * 12. Rollback on error
 */
export async function uninstallCommand(
  options: UninstallOptions = {}
): Promise<{ success: boolean; dryRun: boolean; report?: PreflightReport }> {
  // 1. Resolve scope (AC-19, AC-20)
  let scope: ScopeResult;
  try {
    scope = await resolveScope({
      project: options.projectDir,
      global: options.global,
    });
  } catch (err: any) {
    throw new Error(`Scope resolution failed: ${err.message}`);
  }

  const scopeDir = scope.rootDir;

  // 2. Read manifest; block if missing/corrupt/incompatible
  let manifest: Manifest | null;
  try {
    manifest = await readManifest(scopeDir);
  } catch (err: any) {
    throw new Error(`Cannot read manifest: ${err.message}`);
  }

  if (!manifest) {
    throw new Error(
      "No manifest found. Cannot uninstall without a manifest. " +
        "Run 'sof install' first or check your project directory."
    );
  }

  // 3. Perform complete preflight (read-only) (AC-23)
  const preflight = await performUninstallPreflight(scopeDir, scope, manifest, options);

  // Build the report for --dry-run
  const allOps: PlannedOperationType[] = [
    ...preflight.agentDeleteOps.map((op) => ({ ...op, type: "backup" as const, sourcePath: op.sourcePath })),
    ...preflight.agentDeleteOps,
    ...preflight.configWriteOps,
    ...preflight.ancestorDeleteOps,
    ...(preflight.configFileDeleteOp ? [preflight.configFileDeleteOp] : []),
    ...(preflight.manifestDeleteOp ? [preflight.manifestDeleteOp] : []),
  ];

  const report: PreflightReport = {
    orderedOperations: allOps,
    conflicts: [
      ...preflight.conflicts,
      ...preflight.skippedRules.map(
        (r) => `Skipped rule ${r.ruleKey} at ${r.targetPath}: ${r.reason}`
      ),
    ],
    backups: preflight.agentDeleteOps.map((op) => op.sourcePath),
    wouldSucceed:
      preflight.conflicts.length === 0 && preflight.skippedRules.length === 0,
  };

  // 4. If --dry-run: report, exit 0, zero writes (AC-15, AC-23, AC-24)
  if (options.dryRun) {
    return { success: true, dryRun: true, report };
  }

  // Check for blocking conflicts
  if (preflight.conflicts.length > 0) {
    throw new Error(
      `Cannot uninstall: conflicts detected:\n${preflight.conflicts.join("\n")}`
    );
  }

  // Check for skipped rules (without --force)
  if (preflight.skippedRules.length > 0 && !options.force) {
    throw new Error(
      `Cannot uninstall: user-modified rules detected (use --force to override):\n${preflight.skippedRules
        .map((r) => `  ${r.targetPath}.${r.ruleKey}: ${r.reason}`)
        .join("\n")}`
    );
  }

  // 5. Create backup directory
  const backupDir = await createBackupDir(scopeDir);

  // 6-12. Execute uninstall steps
  await executeUninstallSteps(scopeDir, scope, manifest, preflight, backupDir);

  return { success: true, dryRun: false };
}
