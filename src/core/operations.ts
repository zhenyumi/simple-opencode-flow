// Operations helper: pre-validation, backup, atomic replacement, rollback.
// Safety model: preflight before writes, mandatory backups, atomic temp+rename, best-effort rollback.

import { randomBytes } from 'node:crypto';
import {
  mkdir,
  cp,
  writeFile,
  rename,
  unlink,
  stat,
  readdir,
  rm,
  access,
} from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import type { PlannedOperation, PreflightReport } from '../types.js';

/** Prefix for timestamped backup directories within scope root. */
export const BACKUP_DIR_PREFIX = '.sof-backups';

/**
 * Generate a unique temporary suffix for atomic writes.
 */
function tempSuffix(): string {
  return `sof-tmp-${randomBytes(6).toString('hex')}`;
}

/**
 * Check if a path exists.
 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Perform preflight analysis — PURE READ-ONLY.
 * Validates all operations without making any filesystem writes.
 * Returns ordered operations, conflicts, backups needed, and whether the operation would succeed.
 */
export async function performPreflight(
  scopeDir: string,
  operations: PlannedOperation[]
): Promise<PreflightReport> {
  const conflicts: string[] = [];
  const backups: string[] = [];
  const orderedOperations: PlannedOperation[] = [];

  for (const op of operations) {
    switch (op.type) {
      case 'backup': {
        // Check source file exists for backup
        const exists = await pathExists(op.sourcePath);
        if (!exists) {
          conflicts.push(`Backup source does not exist: ${op.sourcePath}`);
        } else {
          backups.push(op.sourcePath);
          orderedOperations.push(op);
        }
        break;
      }
      case 'write': {
        // For writes, check if dest directory exists or can be created
        const destDir = dirname(op.destPath!);
        const dirExists = await pathExists(destDir);
        if (!dirExists) {
          // Will need to create ancestor directories
          orderedOperations.push({
            type: 'write',
            sourcePath: '',
            destPath: op.destPath,
            content: op.content,
          });
        } else {
          orderedOperations.push(op);
        }
        break;
      }
      case 'delete': {
        // Check file exists before delete
        const exists = await pathExists(op.sourcePath);
        if (!exists) {
          conflicts.push(`Delete target does not exist: ${op.sourcePath}`);
        } else {
          orderedOperations.push(op);
        }
        break;
      }
      case 'rename': {
        // Check source exists for rename
        const exists = await pathExists(op.sourcePath);
        if (!exists) {
          conflicts.push(`Rename source does not exist: ${op.sourcePath}`);
        } else {
          orderedOperations.push(op);
        }
        break;
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
 * Create a timestamped backup directory within the scope root.
 * Format: <scopeDir>/.opencode/.sof-backups-<ISO timestamp>-<random>
 */
export async function createBackupDir(scopeDir: string): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
  const random = randomBytes(4).toString('hex');
  const backupDir = join(
    scopeDir,
    '.opencode',
    `${BACKUP_DIR_PREFIX}-${timestamp}-${random}`
  );
  await mkdir(backupDir, { recursive: true });
  return backupDir;
}

/**
 * Copy a file to the backup directory, preserving its basename.
 * Returns the backup file path.
 */
export async function backupFile(
  backupDir: string,
  filePath: string
): Promise<string> {
  const backupPath = join(backupDir, basename(filePath));
  await cp(filePath, backupPath);
  return backupPath;
}

/**
 * Atomically write content to a destination path.
 * Uses temp file in same directory + rename for atomicity.
 */
export async function atomicWrite(
  destPath: string,
  content: string | Buffer
): Promise<void> {
  const dir = dirname(destPath);
  const tempPath = join(dir, `${basename(destPath)}.${tempSuffix()}`);

  try {
    await writeFile(tempPath, content);
    await rename(tempPath, destPath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Atomically delete a file.
 * Verifies existence first, then deletes.
 */
export async function atomicDelete(filePath: string): Promise<void> {
  const exists = await pathExists(filePath);
  if (!exists) {
    throw new Error(`Cannot delete: file does not exist: ${filePath}`);
  }
  await unlink(filePath);
}

/**
 * Best-effort rollback of newly created files.
 * Logs errors but does not throw.
 */
export async function rollbackCreatedFiles(
  createdFiles: string[]
): Promise<void> {
  for (const file of createdFiles) {
    try {
      const exists = await pathExists(file);
      if (exists) {
        await unlink(file);
      }
    } catch (err) {
      // Best-effort: log but continue
      console.error(`Rollback: failed to delete ${file}:`, err);
    }
  }
}

/**
 * Best-effort restore of backed-up files from backup directory.
 * Restores each file to its original path.
 */
export async function restoreBackups(
  backupDir: string,
  originalPaths: string[]
): Promise<void> {
  for (const originalPath of originalPaths) {
    try {
      const backupPath = join(backupDir, basename(originalPath));
      const exists = await pathExists(backupPath);
      if (exists) {
        await cp(backupPath, originalPath);
      }
    } catch (err) {
      // Best-effort: log but continue
      console.error(`Rollback: failed to restore ${originalPath}:`, err);
    }
  }
}

/**
 * Discover all backup directories within the scope root.
 * Returns sorted list of backup directory paths.
 */
export async function findBackupDirs(scopeDir: string): Promise<string[]> {
  const sofDir = join(scopeDir, '.opencode');
  const exists = await pathExists(sofDir);
  if (!exists) {
    return [];
  }

  const entries = await readdir(sofDir);
  const backupDirs = entries
    .filter((entry) => entry.startsWith(BACKUP_DIR_PREFIX))
    .map((entry) => join(sofDir, entry))
    .sort();

  return backupDirs;
}

/**
 * Execute install operations with safe ordering.
 * MUST patch config protection BEFORE copying/writing agents.
 * On error, performs best-effort rollback of completed writes.
 */
export async function executeInstall(
  operations: PlannedOperation[],
  backupDir: string
): Promise<void> {
  // Separate operations by type for ordering
  const backupOps = operations.filter((op) => op.type === 'backup');
  const writeOps = operations.filter((op) => op.type === 'write');
  const deleteOps = operations.filter((op) => op.type === 'delete');
  const renameOps = operations.filter((op) => op.type === 'rename');

  // Execute in order: backups first, then writes (config before agents), then deletes, then renames
  const completedFiles: string[] = [];

  try {
    // 1. Backup operations
    for (const op of backupOps) {
      await backupFile(backupDir, op.sourcePath);
    }

    // 2. Write operations (config before agents - caller must order)
    for (const op of writeOps) {
      await atomicWrite(op.destPath!, op.content!);
      completedFiles.push(op.destPath!);
    }

    // 3. Delete operations
    for (const op of deleteOps) {
      await atomicDelete(op.sourcePath);
    }

    // 4. Rename operations
    for (const op of renameOps) {
      await rename(op.sourcePath, op.destPath!);
    }
  } catch (err) {
    // Best-effort rollback
    await rollbackCreatedFiles(completedFiles);
    throw err;
  }
}

/**
 * Execute update operations with safe ordering.
 * MUST re-patch config protection BEFORE overwriting agents.
 * On error, performs best-effort rollback restoring backups.
 */
export async function executeUpdate(
  operations: PlannedOperation[],
  backupDir: string
): Promise<void> {
  // Separate operations by type for ordering
  const backupOps = operations.filter((op) => op.type === 'backup');
  const writeOps = operations.filter((op) => op.type === 'write');
  const deleteOps = operations.filter((op) => op.type === 'delete');
  const renameOps = operations.filter((op) => op.type === 'rename');

  const completedFiles: string[] = [];
  const backedUpPaths: string[] = [];

  try {
    // 1. Backup operations
    for (const op of backupOps) {
      await backupFile(backupDir, op.sourcePath);
      backedUpPaths.push(op.sourcePath);
    }

    // 2. Write operations (config before agents - caller must order)
    for (const op of writeOps) {
      await atomicWrite(op.destPath!, op.content!);
      completedFiles.push(op.destPath!);
    }

    // 3. Delete operations
    for (const op of deleteOps) {
      await atomicDelete(op.sourcePath);
    }

    // 4. Rename operations
    for (const op of renameOps) {
      await rename(op.sourcePath, op.destPath!);
    }
  } catch (err) {
    // Best-effort rollback: restore backups first, then delete new files
    // Exclude backed up paths from rollback since they're being restored
    const newFilesOnly = completedFiles.filter(
      (f) => !backedUpPaths.includes(f)
    );
    await restoreBackups(backupDir, backedUpPaths);
    await rollbackCreatedFiles(newFilesOnly);
    throw err;
  }
}

/**
 * Execute uninstall operations with safe ordering.
 * MUST remove agent files BEFORE removing config protection.
 * On error, performs best-effort rollback restoring backups.
 */
export async function executeUninstall(
  operations: PlannedOperation[],
  backupDir: string
): Promise<void> {
  // Separate operations by type for ordering
  const backupOps = operations.filter((op) => op.type === 'backup');
  const deleteOps = operations.filter((op) => op.type === 'delete');
  const writeOps = operations.filter((op) => op.type === 'write');
  const renameOps = operations.filter((op) => op.type === 'rename');

  const completedFiles: string[] = [];
  const backedUpPaths: string[] = [];

  try {
    // 1. Backup operations
    for (const op of backupOps) {
      await backupFile(backupDir, op.sourcePath);
      backedUpPaths.push(op.sourcePath);
    }

    // 2. Delete operations (agents before config - caller must order)
    for (const op of deleteOps) {
      await atomicDelete(op.sourcePath);
    }

    // 3. Write operations (config removal after agents)
    for (const op of writeOps) {
      await atomicWrite(op.destPath!, op.content!);
      completedFiles.push(op.destPath!);
    }

    // 4. Rename operations
    for (const op of renameOps) {
      await rename(op.sourcePath, op.destPath!);
    }
  } catch (err) {
    // Best-effort rollback: restore backups first, then delete new files
    // Exclude backed up paths from rollback since they're being restored
    const newFilesOnly = completedFiles.filter(
      (f) => !backedUpPaths.includes(f)
    );
    await restoreBackups(backupDir, backedUpPaths);
    await rollbackCreatedFiles(newFilesOnly);
    throw err;
  }
}
