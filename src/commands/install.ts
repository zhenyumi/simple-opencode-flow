import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { resolveScope } from "../core/project-root.js";
import {
  readManifest,
  writeManifest,
  createManifest,
  addAgentEntry,
  addConfigRuleEntry,
  computeConfigFingerprint,
  type Manifest,
  type ManifestEntry,
  type ConfigRuleEntry,
} from "../core/manifest.js";
import {
  getPackageAgentDir,
  getAgentFiles,
  copyAgent,
  computeHash,
  getRenameMap,
} from "../core/agents.js";
import {
  readConfigParseTree,
  applyManagedDenyRules,
  writePatchedConfig,
  findTaskNode,
  type ConfigParseTree,
} from "../core/config.js";
import { createBackupDir, backupFile, executeInstall, atomicWrite } from "../core/operations.js";
import {
  detectLegacyAgents,
  isMigrationAllowed,
  migrateLegacyAgents,
  type LegacyDetection,
} from "../core/legacy.js";
import type { InstallOptions, PreflightReport, PlannedOperation } from "../types.js";

/**
 * Managed deny rule targets: Build and Plan Task permission paths.
 */
const MANAGED_TARGET_PATHS = [
  ["agent", "build", "permission", "task"],
  ["agent", "plan", "permission", "task"],
] as const;

/**
 * Install command: installs agents with preflight validation, safe ordering,
 * and legacy migration support.
 *
 * Flow:
 * 1. Resolve scope
 * 2. Perform complete pure-read-only preflight
 * 3. --dry-run: report, exit 0, zero writes
 * 4. Conflicts without --force: abort
 * 5. Create backup directory (first write)
 * 6. Patch config protection FIRST
 * 7. Detect and migrate legacy if --migrate-legacy
 * 8. Copy agents with sof- renaming
 * 9. Create/update manifest
 * 10. Write manifest LAST
 * 11. Rollback on error
 */
export async function install(options: InstallOptions = {}): Promise<PreflightReport> {
  // 1. Resolve scope
  const scope = await resolveScope({
    project: options.projectDir,
    global: options.global,
  });

  // 2. Perform complete pure-read-only preflight
  const preflight = await performInstallPreflight(
    scope.rootDir,
    scope.configPath,
    scope.agentsDir,
    options
  );

  // 3. --dry-run: report, exit 0, zero writes
  if (options.dryRun) {
    return preflight;
  }

  // 4. Check for conflicts (unless --force)
  if (preflight.conflicts.length > 0 && !options.force) {
    throw new Error(
      `Install blocked by conflicts:\n${preflight.conflicts.join("\n")}\n` +
      "Use --force to overwrite conflicting files."
    );
  }

  // 5. Create backup directory — first write
  const backupDir = await createBackupDir(scope.rootDir);

  // Track files for rollback
  const backedUpFiles: string[] = [];
  const createdFiles: string[] = [];

  try {
    // 6. Patch config protection FIRST (protection before exposure)
    const configPatched = await patchConfigProtection(
      scope.configPath,
      backupDir,
      backedUpFiles,
      createdFiles
    );

    // 7. Detect and migrate legacy if --migrate-legacy
    let legacyDetections: LegacyDetection[] = [];
    if (options.migrateLegacy) {
      legacyDetections = await detectLegacyAgents(scope.agentsDir);

      if (legacyDetections.length > 0) {
        const migrationCheck = isMigrationAllowed(legacyDetections, options.force ?? false);

        if (!migrationCheck.allowed) {
          throw new Error(
            `Legacy migration blocked by conflicts:\n` +
            migrationCheck.conflicts
              .map((c) => `  ${c.oldFilename}: hash mismatch (expected ${c.expectedHash}, got ${c.computedHash})`)
              .join("\n") +
            "\nUse --force --migrate-legacy to skip conflicting files."
          );
        }

        await migrateLegacyAgents(scope.agentsDir, legacyDetections);
      }
    }

    // 8. Copy agents from package agents/ to target with sof- renaming
    const packageAgentDir = getPackageAgentDir();
    const agentFiles = await getAgentFiles(packageAgentDir);
    const renameMap = getRenameMap();

    // Ensure agents directory exists
    await mkdir(scope.agentsDir, { recursive: true });

    for (const agentFile of agentFiles) {
      const isFlow = agentFile === "flow.md";
      const targetName = isFlow ? "flow.md" : renameMap.get(agentFile) ?? agentFile;
      const sourcePath = join(packageAgentDir, agentFile);
      const targetPath = join(scope.agentsDir, targetName);

      // Backup existing file if present
      try {
        await access(targetPath);
        await backupFile(backupDir, targetPath);
        backedUpFiles.push(targetPath);
      } catch {
        // File doesn't exist — no backup needed
      }

      // Copy agent with rename
      await copyAgent(sourcePath, scope.agentsDir, targetName);
      createdFiles.push(targetPath);
    }

    // 9. Create/update manifest
    const existingManifest = await readManifest(scope.rootDir);
    let manifest = existingManifest ?? createManifest(scope.rootDir, "0.1.0");

    // Add agent entries
    for (const agentFile of agentFiles) {
      const isFlow = agentFile === "flow.md";
      const targetName = isFlow ? "flow.md" : renameMap.get(agentFile) ?? agentFile;
      const agentName = targetName.replace(".md", "");
      const targetPath = join(scope.agentsDir, targetName);
      const sourcePath = join(packageAgentDir, agentFile);

      const sourceHash = await computeHash(sourcePath);
      const targetHash = await computeHash(targetPath);

      const entry: ManifestEntry = {
        agentName,
        installedPath: targetPath,
        sourceHash: targetHash,
        installedAt: new Date().toISOString(),
        managedBy: "sof",
        configRules: configPatched.rules.map((r) => ({
          targetPath: r.targetPath,
          ruleKey: r.ruleKey,
          ruleValue: r.newValue,
          existedBefore: r.existedBefore,
          previousValue: r.previousValue ?? null,
          previousOrderedPosition: r.previousOrderedPosition ?? null,
          action: r.action as "inserted" | "changed" | "reordered",
          lastWrittenValue: r.newValue,
          lastWrittenOrderedPosition: r.newPosition ?? null,
          reordered: r.reordered ?? false,
          originalPosition: r.originalPosition ?? null,
          newPosition: r.newPosition ?? null,
        })),
        scalarConversion: configPatched.scalarConversion
          ? { originalValue: configPatched.scalarConversion.originalValue }
          : null,
        createdAncestors: [],
        createdConfigFile: null,
        initialConfigState: null,
        configPath: scope.configPath,
        lastWrittenStateFingerprint: await computeConfigFingerprint(scope.configPath, []),
        manifestSchemaVersion: "1.0",
        installerVersion: "0.1.0",
      };

      manifest = addAgentEntry(manifest, agentName, entry);
    }

    // 10. Write manifest — LAST
    await writeManifest(scope.rootDir, manifest);

    return preflight;
  } catch (err) {
    // 11. Best-effort rollback on error
    console.error("Install failed, performing best-effort rollback...");

    // Restore backed-up files
    for (const originalPath of backedUpFiles) {
      try {
        const backupPath = join(backupDir, basename(originalPath));
        const { cp } = await import("node:fs/promises");
        await cp(backupPath, originalPath);
      } catch (rollbackErr) {
        console.error(`Rollback: failed to restore ${originalPath}:`, rollbackErr);
      }
    }

    // Remove newly created files
    for (const createdFile of createdFiles) {
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(createdFile);
      } catch (rollbackErr) {
        console.error(`Rollback: failed to remove ${createdFile}:`, rollbackErr);
      }
    }

    throw err;
  }
}

/**
 * Perform complete pure-read-only preflight for install.
 * Validates config, detects legacy agents, and determines conflicts.
 */
async function performInstallPreflight(
  scopeDir: string,
  configPath: string,
  agentsDir: string,
  options: InstallOptions
): Promise<PreflightReport> {
  const conflicts: string[] = [];
  const backups: string[] = [];
  const orderedOperations: PlannedOperation[] = [];

  const packageAgentDir = getPackageAgentDir();
  const agentFiles = await getAgentFiles(packageAgentDir);
  const renameMap = getRenameMap();

  // Check config file
  let configNeedsPatch = false;
  try {
    const configTree = await readConfigParseTree(configPath);

    // Validate config is parseable (no duplicate keys, compatible ancestors)
    for (const targetPath of MANAGED_TARGET_PATHS) {
      const taskNode = findTaskNode(configTree, [...targetPath]);
      if (!taskNode) {
        // Config path doesn't exist — will be created
        configNeedsPatch = true;
        continue;
      }

      // Check if managed rules exist
      if (taskNode.type === "object" && taskNode.children) {
        const managedKeys = ["sof-*", "flow"];
        for (const managedKey of managedKeys) {
          let found = false;
          for (const child of taskNode.children) {
            if (child.type === "property" && child.children && child.children[0]) {
              const keyNode = child.children[0];
              if (keyNode.type === "string" && keyNode.value === managedKey) {
                found = true;
                const valueNode = child.children[1];
                if (valueNode && valueNode.type === "string" && valueNode.value !== "deny") {
                  // Rule exists but has wrong value — will be updated
                  configNeedsPatch = true;
                }
                break;
              }
            }
          }
          if (!found) {
            // Rule doesn't exist — will be inserted
            configNeedsPatch = true;
          }
        }
      } else {
        // Task node is not an object (could be a scalar) — needs update
        configNeedsPatch = true;
      }
    }
  } catch (err) {
    // Config file doesn't exist or is malformed
    configNeedsPatch = true;
  }

  if (configNeedsPatch) {
    backups.push(configPath);
    orderedOperations.push({
      type: "backup",
      sourcePath: configPath,
    });
  }

  // Check agent files for conflicts
  for (const agentFile of agentFiles) {
    const isFlow = agentFile === "flow.md";
    const targetName = isFlow ? "flow.md" : renameMap.get(agentFile) ?? agentFile;
    const targetPath = join(agentsDir, targetName);
    const sourcePath = join(packageAgentDir, agentFile);

    try {
      await access(targetPath);
      // File exists — check if it's a conflict
      const currentHash = await computeHash(targetPath);
      const sourceHash = await computeHash(sourcePath);

      if (currentHash !== sourceHash) {
        // Different content — conflict (unless --force)
        conflicts.push(
          `Agent file already exists with different content: ${targetName}`
        );
      } else {
        // Same content — will be overwritten (no conflict)
        backups.push(targetPath);
        orderedOperations.push({
          type: "backup",
          sourcePath: targetPath,
        });
      }
    } catch {
      // File doesn't exist — will be created
      orderedOperations.push({
        type: "write",
        sourcePath: sourcePath,
        destPath: targetPath,
        content: await readFile(sourcePath),
      });
    }
  }

  // Check legacy agents if --migrate-legacy
  if (options.migrateLegacy) {
    const legacyDetections = await detectLegacyAgents(agentsDir);
    for (const detection of legacyDetections) {
      if (detection.conflict) {
        conflicts.push(
          `Legacy agent hash mismatch: ${detection.oldFilename} ` +
          `(expected ${detection.expectedHash}, got ${detection.computedHash})`
        );
      }
    }
  }

  return {
    orderedOperations,
    conflicts,
    backups,
    wouldSucceed: conflicts.length === 0,
  };
}

/**
 * Patch config protection (Build + Plan Task deny rules).
 * Returns the patch result with rule changes for manifest tracking.
 */
async function patchConfigProtection(
  configPath: string,
  backupDir: string,
  backedUpFiles: string[],
  createdFiles: string[]
): Promise<{
  modified: boolean;
  rules: Array<{
    targetPath: string;
    ruleKey: string;
    action: string;
    newValue: string;
    existedBefore: boolean;
    previousValue?: string;
    previousOrderedPosition?: number;
    reordered?: boolean;
    originalPosition?: number;
    newPosition?: number;
  }>;
  scalarConversion?: { originalValue: string };
}> {
  const rules: Array<{
    targetPath: string;
    ruleKey: string;
    action: string;
    newValue: string;
    existedBefore: boolean;
    previousValue?: string;
    previousOrderedPosition?: number;
    reordered?: boolean;
    originalPosition?: number;
    newPosition?: number;
  }> = [];

  let scalarConversion: { originalValue: string } | undefined;
  let configModified = false;

  // Check if config file exists
  let configExists = true;
  try {
    await access(configPath);
  } catch {
    configExists = false;
  }

  if (!configExists) {
    // Create empty config file
    await mkdir(join(configPath, ".."), { recursive: true });
    await writeFile(configPath, "{}");
    createdFiles.push(configPath);
    configExists = true;
  }

  // Backup config
  await backupFile(backupDir, configPath);
  backedUpFiles.push(configPath);

  // Read and patch config
  const configTree = await readConfigParseTree(configPath);

  for (const targetPath of MANAGED_TARGET_PATHS) {
    const targetPathStr = targetPath.join(".");
    const patchResult = applyManagedDenyRules(configTree, [...targetPath]);

    if (patchResult.modified) {
      configModified = true;
    }

    // Track rule changes for manifest
    for (const rule of patchResult.rules) {
      rules.push({
        targetPath: targetPathStr,
        ruleKey: rule.key,
        action: rule.action,
        newValue: rule.newValue,
        existedBefore: rule.previousValue !== undefined,
        previousValue: rule.previousValue,
        previousOrderedPosition: rule.originalPosition,
        reordered: rule.reordered,
        originalPosition: rule.originalPosition,
        newPosition: rule.newPosition,
      });
    }

    if (patchResult.scalarConversion) {
      scalarConversion = patchResult.scalarConversion;
    }
  }

  // Write patched config if modified
  if (configModified) {
    await writePatchedConfig(configPath, configTree);
    createdFiles.push(configPath);
  }

  return {
    modified: configModified,
    rules,
    scalarConversion,
  };
}
