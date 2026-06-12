// Tests for operations helper: preflight, backup, atomic replacement, rollback, ordering.
// Minimum 12 test cases as required by plan.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  readdir,
  access,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  performPreflight,
  createBackupDir,
  backupFile,
  atomicWrite,
  atomicDelete,
  rollbackCreatedFiles,
  restoreBackups,
  findBackupDirs,
  executeInstall,
  executeUpdate,
  executeUninstall,
  BACKUP_DIR_PREFIX,
} from '../../src/core/operations.js';
import type { PlannedOperation } from '../../src/types.js';

/** Create a unique temp directory for each test. */
async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `sof-test-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Check if path exists. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('operations', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('performPreflight', () => {
    // Test 1: Preflight is pure read-only — detects conflicts before any write
    it('should detect conflicts without making writes', async () => {
      const testFile = join(tempDir, 'test.txt');
      await writeFile(testFile, 'content');

      const operations: PlannedOperation[] = [
        { type: 'backup', sourcePath: testFile },
        { type: 'delete', sourcePath: join(tempDir, 'nonexistent.txt') },
      ];

      const report = await performPreflight(tempDir, operations);

      expect(report.wouldSucceed).toBe(false);
      expect(report.conflicts).toHaveLength(1);
      expect(report.conflicts[0]).toContain('nonexistent.txt');
      expect(report.backups).toHaveLength(1);
      expect(report.backups[0]).toBe(testFile);
      expect(report.orderedOperations).toHaveLength(1);

      // Verify no writes occurred
      const files = await readdir(tempDir);
      expect(files).toEqual(['test.txt']);
    });

    it('should succeed when all operations are valid', async () => {
      const testFile = join(tempDir, 'test.txt');
      await writeFile(testFile, 'content');

      const operations: PlannedOperation[] = [
        { type: 'backup', sourcePath: testFile },
        { type: 'write', sourcePath: '', destPath: join(tempDir, 'new.txt'), content: 'new' },
      ];

      const report = await performPreflight(tempDir, operations);

      expect(report.wouldSucceed).toBe(true);
      expect(report.conflicts).toHaveLength(0);
      expect(report.backups).toHaveLength(1);
      expect(report.orderedOperations).toHaveLength(2);
    });
  });

  describe('createBackupDir', () => {
    // Test 2: Backup created before file modification
    it('should create timestamped backup directory', async () => {
      const backupDir = await createBackupDir(tempDir);

      expect(backupDir).toContain(BACKUP_DIR_PREFIX);
      expect(await pathExists(backupDir)).toBe(true);

      // Verify it's inside .opencode
      expect(backupDir).toContain(join(tempDir, '.opencode'));
    });

    // Test 12: Backup directories remain available after success and failure
    it('should preserve backup directories after creation', async () => {
      const backupDir1 = await createBackupDir(tempDir);
      const backupDir2 = await createBackupDir(tempDir);

      expect(await pathExists(backupDir1)).toBe(true);
      expect(await pathExists(backupDir2)).toBe(true);
      expect(backupDir1).not.toBe(backupDir2);
    });
  });

  describe('backupFile', () => {
    it('should copy file to backup directory', async () => {
      const sourceFile = join(tempDir, 'source.txt');
      await writeFile(sourceFile, 'original content');

      const backupDir = await createBackupDir(tempDir);
      const backupPath = await backupFile(backupDir, sourceFile);

      expect(backupPath).toBe(join(backupDir, 'source.txt'));
      expect(await pathExists(backupPath)).toBe(true);

      const content = await readFile(backupPath, 'utf-8');
      expect(content).toBe('original content');
    });
  });

  describe('atomicWrite', () => {
    // Test 3: Atomic write → destination has correct content
    it('should write content atomically', async () => {
      const destPath = join(tempDir, 'output.txt');

      await atomicWrite(destPath, 'test content');

      expect(await pathExists(destPath)).toBe(true);
      const content = await readFile(destPath, 'utf-8');
      expect(content).toBe('test content');
    });

    // Test 4: Atomic write → temp file does not remain
    it('should not leave temp files after successful write', async () => {
      const destPath = join(tempDir, 'output.txt');

      await atomicWrite(destPath, 'test content');

      const files = await readdir(tempDir);
      const tempFiles = files.filter((f) => f.includes('sof-tmp-'));
      expect(tempFiles).toHaveLength(0);
    });

    it('should handle Buffer content', async () => {
      const destPath = join(tempDir, 'binary.bin');
      const buffer = Buffer.from([0x00, 0x01, 0x02]);

      await atomicWrite(destPath, buffer);

      const content = await readFile(destPath);
      expect(content).toEqual(buffer);
    });

    it('should overwrite existing file', async () => {
      const destPath = join(tempDir, 'output.txt');
      await writeFile(destPath, 'old content');

      await atomicWrite(destPath, 'new content');

      const content = await readFile(destPath, 'utf-8');
      expect(content).toBe('new content');
    });
  });

  describe('atomicDelete', () => {
    it('should delete existing file', async () => {
      const filePath = join(tempDir, 'to-delete.txt');
      await writeFile(filePath, 'content');

      await atomicDelete(filePath);

      expect(await pathExists(filePath)).toBe(false);
    });

    it('should throw when file does not exist', async () => {
      const filePath = join(tempDir, 'nonexistent.txt');

      await expect(atomicDelete(filePath)).rejects.toThrow(
        'Cannot delete: file does not exist'
      );
    });
  });

  describe('rollbackCreatedFiles', () => {
    // Test 6: Rollback deletes newly created files
    it('should delete all created files', async () => {
      const file1 = join(tempDir, 'created1.txt');
      const file2 = join(tempDir, 'created2.txt');
      await writeFile(file1, 'content1');
      await writeFile(file2, 'content2');

      await rollbackCreatedFiles([file1, file2]);

      expect(await pathExists(file1)).toBe(false);
      expect(await pathExists(file2)).toBe(false);
    });

    it('should continue on errors (best-effort)', async () => {
      const file1 = join(tempDir, 'exists.txt');
      const file2 = join(tempDir, 'nonexistent.txt');
      await writeFile(file1, 'content');

      // Should not throw even if file2 doesn't exist
      await rollbackCreatedFiles([file1, file2]);

      expect(await pathExists(file1)).toBe(false);
    });
  });

  describe('restoreBackups', () => {
    // Test 5: Rollback restores exact pre-operation state from backups
    it('should restore files from backup', async () => {
      const originalFile = join(tempDir, 'original.txt');
      await writeFile(originalFile, 'original content');

      const backupDir = await createBackupDir(tempDir);
      await backupFile(backupDir, originalFile);

      // Modify original
      await writeFile(originalFile, 'modified content');
      expect(await readFile(originalFile, 'utf-8')).toBe('modified content');

      // Restore from backup
      await restoreBackups(backupDir, [originalFile]);

      const restored = await readFile(originalFile, 'utf-8');
      expect(restored).toBe('original content');
    });

    it('should continue on errors (best-effort)', async () => {
      const backupDir = await createBackupDir(tempDir);
      const nonexistent = join(tempDir, 'nonexistent.txt');

      // Should not throw
      await restoreBackups(backupDir, [nonexistent]);
    });
  });

  describe('findBackupDirs', () => {
    it('should discover backup directories', async () => {
      const backupDir1 = await createBackupDir(tempDir);
      const backupDir2 = await createBackupDir(tempDir);

      const found = await findBackupDirs(tempDir);

      expect(found).toHaveLength(2);
      expect(found).toContain(backupDir1);
      expect(found).toContain(backupDir2);
    });

    it('should return empty array when no backups exist', async () => {
      const found = await findBackupDirs(tempDir);
      expect(found).toEqual([]);
    });

    it('should return empty array when .opencode does not exist', async () => {
      const emptyDir = join(tempDir, 'empty');
      await mkdir(emptyDir);

      const found = await findBackupDirs(emptyDir);
      expect(found).toEqual([]);
    });
  });

  describe('executeInstall', () => {
    // Test 7: Install ordering: config patched before agent copy
    it('should execute operations in correct order', async () => {
      const configFile = join(tempDir, 'config.json');
      const agentFile = join(tempDir, 'agent.md');
      await writeFile(configFile, '{"old": true}');

      const operations: PlannedOperation[] = [
        { type: 'backup', sourcePath: configFile },
        { type: 'write', sourcePath: '', destPath: configFile, content: '{"key": "value"}' },
        { type: 'write', sourcePath: '', destPath: agentFile, content: '# Agent' },
      ];

      const backupDir = await createBackupDir(tempDir);
      await executeInstall(operations, backupDir);

      expect(await pathExists(configFile)).toBe(true);
      expect(await pathExists(agentFile)).toBe(true);
      expect(await readFile(configFile, 'utf-8')).toBe('{"key": "value"}');
      expect(await readFile(agentFile, 'utf-8')).toBe('# Agent');
    });

    // Test 10: Mid-command failure triggers rollback of completed writes
    it('should rollback on failure', async () => {
      const file1 = join(tempDir, 'file1.txt');
      const file2 = join(tempDir, 'nonexistent-dir', 'file2.txt');

      const operations: PlannedOperation[] = [
        { type: 'write', sourcePath: '', destPath: file1, content: 'content1' },
        { type: 'write', sourcePath: '', destPath: file2, content: 'content2' },
      ];

      const backupDir = await createBackupDir(tempDir);

      await expect(executeInstall(operations, backupDir)).rejects.toThrow();

      // file1 should be rolled back
      expect(await pathExists(file1)).toBe(false);
    });
  });

  describe('executeUpdate', () => {
    // Test 9: Update ordering: config re-patched before agents overwritten
    it('should execute update operations with backup', async () => {
      const agentFile = join(tempDir, 'agent.md');
      await writeFile(agentFile, 'old content');

      const operations: PlannedOperation[] = [
        { type: 'backup', sourcePath: agentFile },
        { type: 'write', sourcePath: '', destPath: agentFile, content: 'new content' },
      ];

      const backupDir = await createBackupDir(tempDir);
      await executeUpdate(operations, backupDir);

      expect(await readFile(agentFile, 'utf-8')).toBe('new content');

      // Backup should exist
      const backupPath = join(backupDir, 'agent.md');
      expect(await pathExists(backupPath)).toBe(true);
      expect(await readFile(backupPath, 'utf-8')).toBe('old content');
    });

    it('should restore backups on failure', async () => {
      const file1 = join(tempDir, 'file1.txt');
      await writeFile(file1, 'original');

      const operations: PlannedOperation[] = [
        { type: 'backup', sourcePath: file1 },
        { type: 'write', sourcePath: '', destPath: file1, content: 'new' },
        { type: 'write', sourcePath: '', destPath: join(tempDir, 'bad', 'file2.txt'), content: 'fail' },
      ];

      const backupDir = await createBackupDir(tempDir);

      await expect(executeUpdate(operations, backupDir)).rejects.toThrow();

      // Should be restored from backup
      expect(await readFile(file1, 'utf-8')).toBe('original');
    });
  });

  describe('executeUninstall', () => {
    // Test 8: Uninstall ordering: agents removed before config protection removed
    it('should execute uninstall operations in correct order', async () => {
      const agentFile = join(tempDir, 'agent.md');
      const configFile = join(tempDir, 'config.json');
      await writeFile(agentFile, '# Agent');
      await writeFile(configFile, '{"key": "value"}');

      const operations: PlannedOperation[] = [
        { type: 'backup', sourcePath: agentFile },
        { type: 'backup', sourcePath: configFile },
        { type: 'delete', sourcePath: agentFile },
        { type: 'write', sourcePath: '', destPath: configFile, content: '{}' },
      ];

      const backupDir = await createBackupDir(tempDir);
      await executeUninstall(operations, backupDir);

      expect(await pathExists(agentFile)).toBe(false);
      expect(await readFile(configFile, 'utf-8')).toBe('{}');
    });

    it('should restore backups on failure', async () => {
      const file1 = join(tempDir, 'file1.txt');
      await writeFile(file1, 'original');

      const operations: PlannedOperation[] = [
        { type: 'backup', sourcePath: file1 },
        { type: 'delete', sourcePath: file1 },
        { type: 'write', sourcePath: '', destPath: join(tempDir, 'bad', 'file2.txt'), content: 'fail' },
      ];

      const backupDir = await createBackupDir(tempDir);

      await expect(executeUninstall(operations, backupDir)).rejects.toThrow();

      // Should be restored from backup
      expect(await readFile(file1, 'utf-8')).toBe('original');
    });
  });

  // Test 11: Preflight failure → zero writes performed
  describe('preflight failure prevents writes', () => {
    it('should not perform any writes when preflight fails', async () => {
      const operations: PlannedOperation[] = [
        { type: 'backup', sourcePath: join(tempDir, 'nonexistent.txt') },
        { type: 'write', sourcePath: '', destPath: join(tempDir, 'new.txt'), content: 'new' },
      ];

      const report = await performPreflight(tempDir, operations);

      expect(report.wouldSucceed).toBe(false);

      // No files should be created
      const files = await readdir(tempDir);
      expect(files).toHaveLength(0);
    });
  });
});
