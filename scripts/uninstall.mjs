#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmdirSync, copyFileSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(__dirname, '..', 'agents');
const SOF_SUPPORT_SOURCE = resolve(__dirname, '..', 'sof-support');
const GLOBAL_CONFIG_ROOT = resolve(homedir(), '.config', 'opencode');
const GLOBAL_SOF_SUPPORT_ROOT = resolve(GLOBAL_CONFIG_ROOT, 'sof-support');
const GLOBAL_SOF_SUPPORT_PLACEHOLDER = '<GLOBAL_SOF_SUPPORT_ROOT>';

// Parse arguments
const args = process.argv.slice(2);
let scope = 'project';
let dryRun = false;
let help = false;
let scopeSet = false;
let targetPath = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--scope') {
    if (targetPath !== null) {
      console.error('Error: --scope and --target are mutually exclusive');
      process.exit(1);
    }
    scopeSet = true;
    i++;
    if (i >= args.length) {
      console.error('Error: --scope requires a value (project or global)');
      process.exit(1);
    }
    scope = args[i];
    if (scope !== 'project' && scope !== 'global') {
      console.error(`Error: Invalid scope "${scope}". Must be "project" or "global".`);
      process.exit(1);
    }
  } else if (arg === '--target') {
    if (scopeSet) {
      console.error('Error: --scope and --target are mutually exclusive');
      process.exit(1);
    }
    i++;
    if (i >= args.length) {
      console.error('Error: --target requires a value');
      process.exit(1);
    }
    const rawTarget = args[i];
    targetPath = resolve(process.cwd(), rawTarget);
    if (existsSync(targetPath) && statSync(targetPath).isFile()) {
      console.error(`Error: Target path exists as a file: ${targetPath}`);
      process.exit(1);
    }
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg === '--help') {
    help = true;
  } else if (arg.startsWith('-')) {
    console.error(`Error: Unknown flag "${arg}"`);
    process.exit(1);
  } else {
    console.error(`Error: Unexpected argument "${arg}"`);
    process.exit(1);
  }
}

if (help) {
  console.log(`Usage: node scripts/uninstall.mjs [options]

Options:
  --scope <project|global>  Uninstallation scope (default: project; both patch opencode.json)
  --target <path>           Uninstall from a custom project directory (removes .opencode/agents/ at target and patches opencode.json; mutually exclusive with --scope)
  --dry-run                 Show planned operations without executing
  --help                    Show this help message

Examples:
  node scripts/uninstall.mjs --scope project
  node scripts/uninstall.mjs --scope global
  node scripts/uninstall.mjs --target ./my-project
  node scripts/uninstall.mjs --dry-run`);
  process.exit(0);
}

// Validate source directory
if (!existsSync(SOURCE_DIR)) {
  console.error(`Error: Source directory not found: ${SOURCE_DIR}`);
  process.exit(2);
}

const sourceFiles = readdirSync(SOURCE_DIR).filter(f => f.endsWith('.md'));
if (sourceFiles.length === 0) {
  console.error(`Error: Source directory is empty: ${SOURCE_DIR}`);
  process.exit(2);
}

// Validate support directory (optional but removes if present)
const hasSupportDocs = existsSync(SOF_SUPPORT_SOURCE);
const isGlobalInstall = targetPath === null && scope === 'global';

// Determine paths based on scope
const targetDir = targetPath !== null
  ? resolve(targetPath, '.opencode', 'agents')
  : scope === 'project'
    ? resolve(process.cwd(), '.opencode', 'agents')
    : resolve(GLOBAL_CONFIG_ROOT, 'agents');

const configDir = targetPath !== null
  ? targetPath
  : scope === 'project'
    ? process.cwd()
    : GLOBAL_CONFIG_ROOT;

const supportTarget = targetPath !== null
  ? resolve(targetPath, '.opencode', 'sof-support')
  : scope === 'project'
    ? resolve(process.cwd(), '.opencode', 'sof-support')
    : GLOBAL_SOF_SUPPORT_ROOT;

const DENIED_TASK_AGENTS = ['sof-*', 'flow'];
const normalizedGlobalSupportRoot = GLOBAL_SOF_SUPPORT_ROOT.replaceAll('\\', '/');

function expectedAgentContent(srcPath) {
  const sourceContent = readFileSync(srcPath, 'utf-8');
  if (!isGlobalInstall) return Buffer.from(sourceContent);
  return Buffer.from(sourceContent.replaceAll(GLOBAL_SOF_SUPPORT_PLACEHOLDER, normalizedGlobalSupportRoot));
}

// Helper: walk directory recursively and return relative paths
function walkDir(dir, base = dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = fullPath.slice(base.length + 1);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, base));
    } else {
      results.push(relPath);
    }
  }
  return results;
}

// Helper: remove empty directories bottom-up
function removeEmptyDirs(dirPath, stopAt) {
  if (!existsSync(dirPath)) return;
  if (dirPath === stopAt) return;

  const entries = readdirSync(dirPath);
  if (entries.length === 0) {
    if (dryRun) {
      console.log(`[DRY-RUN] Remove empty directory ${dirPath}`);
    } else {
      rmdirSync(dirPath);
      console.log(`Removed empty directory ${dirPath}`);
    }
    removeEmptyDirs(dirname(dirPath), stopAt);
  }
}

// ─── Config preflight (before any file deletion) ───────────────────────────

const jsoncPath = join(configDir, 'opencode.jsonc');
const jsonPath = join(configDir, 'opencode.json');

// Check JSONC
if (existsSync(jsoncPath)) {
  console.error(`Error: Found opencode.jsonc at ${jsoncPath}.`);
  console.error('This uninstaller only patches opencode.json and will not modify JSONC because comments/formatting cannot be safely preserved.');
  console.error('No agent or support files were removed.');
  console.error('Please manually remove SOF task deny entries from opencode.jsonc, or migrate the config to opencode.json and rerun uninstall.');
  process.exit(1);
}

// Parse existing config (if any)
let config = null;
let configExists = existsSync(jsonPath);

if (configExists) {
  try {
    const raw = readFileSync(jsonPath, 'utf-8');
    config = JSON.parse(raw);
  } catch (e) {
    console.error(`Error: Invalid JSON in ${jsonPath}: ${e.message}`);
    console.error('No agent or support files were removed.');
    console.error('Please fix opencode.json and rerun uninstall, or remove SOF files manually if you do not want config cleanup.');
    process.exit(1);
  }

  // Create backup
  if (!dryRun) {
    const backupPath = jsonPath + '.sof-backup';
    try {
      copyFileSync(jsonPath, backupPath);
      console.log(`Created backup: ${backupPath}`);
    } catch (e) {
      console.error(`Error: Failed to create backup at ${backupPath}: ${e.message}`);
      console.error('No agent or support files were removed.');
      console.error('Please check permissions or disk space, then rerun uninstall.');
      process.exit(1);
    }
  } else {
    console.log(`[DRY-RUN] Would create backup: ${jsonPath}.sof-backup`);
  }
}

// ─── U2: File deletion — agents ────────────────────────────────────────────

console.log('\n--- Removing agent files ---');
let removedCount = 0;
let skippedCount = 0;

for (const file of sourceFiles) {
  const srcPath = join(SOURCE_DIR, file);
  const destPath = join(targetDir, file);

  if (!existsSync(destPath)) {
    console.log(`  [SKIP] ${file} (not found at target)`);
    skippedCount++;
    continue;
  }

  const srcContent = expectedAgentContent(srcPath);
  const destContent = readFileSync(destPath);

  if (srcContent.equals(destContent)) {
    if (dryRun) {
      console.log(`  [DRY-RUN] Would remove ${file} (identical)`);
    } else {
      unlinkSync(destPath);
      console.log(`  Removed ${file}`);
    }
    removedCount++;
  } else {
    const sourceDescription = isGlobalInstall ? 'transformed source' : 'source';
    console.warn(`  [SKIP] ${file} (content differs from ${sourceDescription})`);
    skippedCount++;
  }
}

// ─── U2: File deletion — sof-support ───────────────────────────────────────

console.log('\n--- Removing support files ---');
let supportRemovedCount = 0;
let supportSkippedCount = 0;

if (hasSupportDocs) {
  const supportFiles = walkDir(SOF_SUPPORT_SOURCE);
  for (const relPath of supportFiles) {
    const srcPath = join(SOF_SUPPORT_SOURCE, relPath);
    const destPath = join(supportTarget, relPath);

    if (!existsSync(destPath)) {
      console.log(`  [SKIP] sof-support/${relPath} (not found at target)`);
      supportSkippedCount++;
      continue;
    }

    const srcContent = readFileSync(srcPath);
    const destContent = readFileSync(destPath);

    if (srcContent.equals(destContent)) {
      if (dryRun) {
        console.log(`  [DRY-RUN] Would remove sof-support/${relPath} (identical)`);
      } else {
        unlinkSync(destPath);
        console.log(`  Removed sof-support/${relPath}`);
      }
      supportRemovedCount++;
      // Clean up empty parent directories of deleted file (e.g. sof-support/lenses/)
      removeEmptyDirs(dirname(destPath), dirname(supportTarget));
    } else {
      console.warn(`  [SKIP] sof-support/${relPath} (content differs from source)`);
      supportSkippedCount++;
    }
  }
  // Clean up sof-support itself if now empty
  if (supportRemovedCount > 0) {
    removeEmptyDirs(supportTarget, dirname(supportTarget));
  }
} else {
  console.log('  (no support source directory found)');
}

// Clean up empty directories (agent files and/or support files)
if (removedCount > 0 || supportRemovedCount > 0) {
  console.log('\n--- Cleaning empty directories ---');
  if (removedCount > 0) {
    removeEmptyDirs(targetDir, dirname(targetDir));
  }
  // Try to remove .opencode if empty
  const opencodeDir = dirname(targetDir);
  if (existsSync(opencodeDir) && readdirSync(opencodeDir).length === 0) {
    if (dryRun) {
      console.log(`[DRY-RUN] Remove empty directory ${opencodeDir}`);
    } else {
      rmdirSync(opencodeDir);
      console.log(`Removed empty directory ${opencodeDir}`);
    }
  }
}

// ─── U3: Config restoration ────────────────────────────────────────────────

if (config !== null) {
  console.log('\n--- Restoring configuration ---');

  let sofEntriesRemoved = false;

  // Remove DENIED_TASK_AGENTS entries from task permission (only if value is "deny")
  function cleanTaskPermission(permission) {
    if (!permission || typeof permission !== 'object') return;
    const task = permission.task;
    if (!task || typeof task !== 'object') return;

    for (const agent of DENIED_TASK_AGENTS) {
      if (task[agent] === 'deny') {
        delete task[agent];
        sofEntriesRemoved = true;
      }
    }
  }

  // Clean build and plan agents
  for (const agentName of ['build', 'plan']) {
    const agentConfig = config.agent?.[agentName];
    if (agentConfig && typeof agentConfig === 'object') {
      const permission = agentConfig.permission;
      if (permission && typeof permission === 'object') {
        cleanTaskPermission(permission);

        // Bottom-up cleanup: task -> permission -> agentConfig -> agent
        if (permission.task && typeof permission.task === 'object' && Object.keys(permission.task).length === 0) {
          delete permission.task;
        }
        if (Object.keys(permission).length === 0) {
          delete agentConfig.permission;
        }
        if (Object.keys(agentConfig).length === 0) {
          delete config.agent[agentName];
        }
      }
    }
  }

  // Clean up empty agent object
  if (config.agent && typeof config.agent === 'object' && Object.keys(config.agent).length === 0) {
    delete config.agent;
  }

  // Determine output
  const configIsEmpty = Object.keys(config).length === 0;

  if (configIsEmpty && sofEntriesRemoved) {
    // Delete the file entirely
    if (dryRun) {
      console.log('[DRY-RUN] Would remove opencode.json (only contained SOF entries)');
    } else {
      unlinkSync(jsonPath);
      console.log('Removed opencode.json (only contained SOF entries)');
    }
  } else if (configIsEmpty && !sofEntriesRemoved) {
    // Write back empty object
    if (dryRun) {
      console.log('[DRY-RUN] Would write {} to opencode.json');
    } else {
      writeFileSync(jsonPath, '{}\n');
      console.log('Wrote {} to opencode.json');
    }
  } else {
    // Atomic write: temp file -> rename
    if (dryRun) {
      console.log('[DRY-RUN] Would update opencode.json');
    } else {
      const tmpPath = join(configDir, `opencode.json.${process.pid}.tmp`);
      writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n');
      renameSync(tmpPath, jsonPath);
      console.log('Updated opencode.json');
    }
  }
} else if (!configExists) {
  console.log('\nNo opencode.json found - skipped config restoration');
}

// Report
console.log('\n--- Summary ---');
console.log(`Agent files: ${removedCount} removed, ${skippedCount} skipped`);
console.log(`Support files: ${supportRemovedCount} removed, ${supportSkippedCount} skipped`);
console.log(`Config: ${config !== null ? (existsSync(jsonPath) ? 'updated' : 'removed (only contained SOF entries)') : 'not found'}`);

if (dryRun) {
  console.log('\n[DRY-RUN] No changes were made.');
}

process.exit(0);
