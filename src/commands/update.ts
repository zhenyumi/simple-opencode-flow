import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { resolveScope } from "../core/project-root.js";
import { readManifest, writeManifest, computeConfigFingerprint, type Manifest, type ManifestEntry } from "../core/manifest.js";
import { getPackageAgentDir, getAgentFiles, computeHash, getRenameMap } from "../core/agents.js";
import { readConfigParseTree, applyManagedDenyRules, writePatchedConfig, findTaskNode } from "../core/config.js";
import { createBackupDir, backupFile, executeUpdate, atomicWrite } from "../core/operations.js";
import type { UpdateOptions, PreflightReport, PlannedOperation } from "../types.js";

/**
 * Managed deny rule targets: Build and Plan Task permission paths.
 */
const MANAGED_TARGET_PATHS = [
  ["agent", "build", "permission", "task"],
  ["agent", "plan", "permission", "task"],
] as const;

/**
 * Update command: updates agents and config with conflict detection against manifest.
 *
 * Flow:
 * 1. Resolve scope
 * 2. Read manifest; block if missing/corrupt/incompatible
 * 3. Preflight: compare current state against manifest last-written state
 * 4. --dry-run: report, exit 0, zero writes
 * 5. Create backup directory
 * 6. Re-patch config protection FIRST
 * 7. THEN write/overwrite agent files
 * 8. Update manifest
 * 9. Write manifest LAST
 * 10. Rollback on error
 */
export async function update(options: UpdateOptions = {}): Promise<PreflightReport> {
  // 1. Resolve scope
  const scope = await resolveScope({
    project: options.projectDir,
    global: options.global,
  });

  // 2. Read manifest; block if missing, corrupt, or incompatible
  const manifest = await readManifest(scope.rootDir);
  if (!manifest) {
    throw new Error(
      "No manifest found. Run `sof install` first to create a manifest."
    );
  }

  // 3. Perform complete pure-read-only preflight
  const preflight = await performUpdatePreflight(scope.rootDir, scope.configPath, scope.agentsDir, manifest);

  // 4. --dry-run: report, exit 0, zero writes
  if (options.dryRun) {
    return preflight;
  }

  // Check for conflicts (unless --force)
  if (preflight.conflicts.length > 0 && !options.force) {
    throw new Error(
      `Update blocked by conflicts:\n${preflight.conflicts.join("\n")}\n` +
      "Use --force to overwrite user-modified files."
    );
  }

  // 5. Create backup directory — first write
  const backupDir = await createBackupDir(scope.rootDir);

  // Track files for rollback
  const backedUpFiles: string[] = [];
  const createdFiles: string[] = [];

  try {
    // 6. Re-patch config protection FIRST
    const configTree = await readConfigParseTree(scope.configPath);
    let configModified = false;
    const configRules: Array<{ targetPath: string; ruleKey: string; action: string; previousValue?: string; newValue: string; reordered?: boolean; originalPosition?: number; newPosition?: number }> = [];

    for (const targetPath of MANAGED_TARGET_PATHS) {
      const targetPathStr = targetPath.join(".");
      const patchResult = applyManagedDenyRules(configTree, [...targetPath]);

      if (patchResult.modified) {
        configModified = true;
      }

      // Track rule changes for manifest
      for (const rule of patchResult.rules) {
        configRules.push({
          targetPath: targetPathStr,
          ruleKey: rule.key,
          action: rule.action,
          previousValue: rule.previousValue,
          newValue: rule.newValue,
          reordered: rule.reordered,
          originalPosition: rule.originalPosition,
          newPosition: rule.newPosition,
        });
      }
    }

    // Backup and write config if modified
    if (configModified) {
      await backupFile(backupDir, scope.configPath);
      backedUpFiles.push(scope.configPath);
      await writePatchedConfig(scope.configPath, configTree);
      createdFiles.push(scope.configPath);
    }

    // 7. THEN write/overwrite agent files
    const packageAgentDir = getPackageAgentDir();
    const agentFiles = await getAgentFiles(packageAgentDir);
    const renameMap = getRenameMap();

    for (const agentFile of agentFiles) {
      const isFlow = agentFile === "flow.md";
      const targetName = isFlow ? "flow.md" : renameMap.get(agentFile) ?? agentFile;
      const targetPath = join(scope.agentsDir, targetName);
      const sourcePath = join(packageAgentDir, agentFile);

      // Get manifest entry for this agent
      const agentName = targetName.replace(".md", "");
      const manifestEntry = manifest.entries[agentName];

      if (!manifestEntry) {
        // Agent not in manifest — skip (will be handled by install)
        continue;
      }

      // Compare current target hash with manifest last-written hash
      const currentHash = await computeHash(targetPath);
      const sourceHash = await computeHash(sourcePath);

      if (currentHash === manifestEntry.sourceHash) {
        // Target matches manifest last-written state
        if (sourceHash !== manifestEntry.sourceHash) {
          // Package source changed — update agent file
          await backupFile(backupDir, targetPath);
          backedUpFiles.push(targetPath);
          await atomicWrite(targetPath, await readFile(sourcePath));
          createdFiles.push(targetPath);
        }
        // else: no changes needed — skip
      } else {
        // Target differs from manifest last-written — user-modified
        if (options.force) {
          // --force: overwrite user-modified agent
          await backupFile(backupDir, targetPath);
          backedUpFiles.push(targetPath);
          await atomicWrite(targetPath, await readFile(sourcePath));
          createdFiles.push(targetPath);
        }
        // else: conflict already reported in preflight — skip
      }
    }

    // 8. Update manifest entries with new hashes and config fingerprints
    let updatedManifest = { ...manifest };

    // Update agent entries
    for (const agentFile of agentFiles) {
      const isFlow = agentFile === "flow.md";
      const targetName = isFlow ? "flow.md" : renameMap.get(agentFile) ?? agentFile;
      const agentName = targetName.replace(".md", "");
      const sourcePath = join(packageAgentDir, agentFile);
      const targetPath = join(scope.agentsDir, targetName);

      const existingEntry = manifest.entries[agentName];
      if (!existingEntry) continue;

      const newSourceHash = await computeHash(sourcePath);
      const newTargetHash = await computeHash(targetPath);

      // Update config rules for this entry
      const entryConfigRules = configRules.filter((r) => {
        // Assign rules to the first agent entry that has config rules
        // In practice, all rules are shared across entries
        return existingEntry.configRules.some(
          (er) => er.targetPath === r.targetPath && er.ruleKey === r.ruleKey
        ) || existingEntry.configRules.length === 0;
      });

      const updatedEntry: ManifestEntry = {
        ...existingEntry,
        sourceHash: newSourceHash,
        installedAt: new Date().toISOString(),
        configRules: entryConfigRules.length > 0
          ? entryConfigRules.map((r) => ({
              targetPath: r.targetPath,
              ruleKey: r.ruleKey,
              ruleValue: r.newValue,
              existedBefore: existingEntry.configRules.find(
                (er) => er.targetPath === r.targetPath && er.ruleKey === r.ruleKey
              )?.existedBefore ?? false,
              previousValue: r.previousValue ?? null,
              previousOrderedPosition: existingEntry.configRules.find(
                (er) => er.targetPath === r.targetPath && er.ruleKey === r.ruleKey
              )?.previousOrderedPosition ?? null,
              action: r.action as "inserted" | "changed" | "reordered",
              lastWrittenValue: r.newValue,
              lastWrittenOrderedPosition: r.newPosition ?? null,
              reordered: r.reordered ?? false,
              originalPosition: r.originalPosition ?? null,
              newPosition: r.newPosition ?? null,
            }))
          : existingEntry.configRules,
        lastWrittenStateFingerprint: await computeConfigFingerprint(
          scope.configPath,
          []
        ),
      };

      updatedManifest = {
        ...updatedManifest,
        entries: {
          ...updatedManifest.entries,
          [agentName]: updatedEntry,
        },
      };
    }

    // 9. Write manifest — LAST
    await writeManifest(scope.rootDir, updatedManifest);

    return preflight;
  } catch (err) {
    // 10. Best-effort rollback on error
    console.error("Update failed, performing best-effort rollback...");

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
 * Perform complete pure-read-only preflight for update.
 * Compares current state against manifest last-written state.
 */
async function performUpdatePreflight(
  scopeDir: string,
  configPath: string,
  agentsDir: string,
  manifest: Manifest
): Promise<PreflightReport> {
  const conflicts: string[] = [];
  const backups: string[] = [];
  const orderedOperations: PlannedOperation[] = [];

  const packageAgentDir = getPackageAgentDir();
  const agentFiles = await getAgentFiles(packageAgentDir);
  const renameMap = getRenameMap();

  // Check agent files
  for (const agentFile of agentFiles) {
    const isFlow = agentFile === "flow.md";
    const targetName = isFlow ? "flow.md" : renameMap.get(agentFile) ?? agentFile;
    const targetPath = join(agentsDir, targetName);
    const sourcePath = join(packageAgentDir, agentFile);
    const agentName = targetName.replace(".md", "");

    const manifestEntry = manifest.entries[agentName];
    if (!manifestEntry) {
      // Agent not in manifest — will be handled by install
      continue;
    }

    // Compare current target hash with manifest last-written hash
    let currentHash: string;
    try {
      currentHash = await computeHash(targetPath);
    } catch {
      conflicts.push(`Agent file not found: ${targetPath}`);
      continue;
    }

    const sourceHash = await computeHash(sourcePath);

    if (currentHash === manifestEntry.sourceHash) {
      // Target matches manifest last-written state
      if (sourceHash !== manifestEntry.sourceHash) {
        // Package source changed — will update
        backups.push(targetPath);
        orderedOperations.push({
          type: "backup",
          sourcePath: targetPath,
        });
        orderedOperations.push({
          type: "write",
          sourcePath: sourcePath,
          destPath: targetPath,
          content: await readFile(sourcePath),
        });
      }
      // else: no changes needed
    } else {
      // Target differs from manifest last-written — user-modified
      conflicts.push(
        `User-modified agent: ${targetName} (current hash differs from manifest last-written state)`
      );
    }
  }

  // Check config protection
  let configNeedsUpdate = false;
  try {
    const configTree = await readConfigParseTree(configPath);

    for (const targetPath of MANAGED_TARGET_PATHS) {
      const taskNode = findTaskNode(configTree, [...targetPath]);
      if (!taskNode) {
        // Config path doesn't exist — will be created
        configNeedsUpdate = true;
        continue;
      }

      // Check if managed rules exist and match manifest last-written state
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
                  configNeedsUpdate = true;
                }
                break;
              }
            }
          }
          if (!found) {
            // Rule doesn't exist — will be inserted
            configNeedsUpdate = true;
          }
        }
      } else {
        // Task node is not an object (could be a scalar) — needs update
        configNeedsUpdate = true;
      }
    }
  } catch {
    // Config file doesn't exist or is malformed — will be handled
    configNeedsUpdate = true;
  }

  if (configNeedsUpdate) {
    backups.push(configPath);
    orderedOperations.push({
      type: "backup",
      sourcePath: configPath,
    });
  }

  return {
    orderedOperations,
    conflicts,
    backups,
    wouldSucceed: conflicts.length === 0,
  };
}
