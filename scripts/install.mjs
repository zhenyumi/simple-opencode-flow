#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(__dirname, '..', 'agents');
const SOF_SUPPORT_SOURCE = resolve(__dirname, '..', 'sof-support');

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
  console.log(`Usage: node scripts/install.mjs [options]

Options:
  --scope <project|global>  Installation scope (default: project)
  --target <path>           Install to a custom project directory (creates .opencode/agents/ at target, patches opencode.json if present; mutually exclusive with --scope)
  --dry-run                 Show planned operations without executing
  --help                    Show this help message

Examples:
  node scripts/install.mjs --scope project
  node scripts/install.mjs --scope global
  node scripts/install.mjs --target ./my-project
  node scripts/install.mjs --dry-run`);
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

// Validate support directory (optional but copies if present)
const hasSupportDocs = existsSync(SOF_SUPPORT_SOURCE);

// Determine paths based on scope
const targetDir = targetPath !== null
  ? resolve(targetPath, '.opencode', 'agents')
  : scope === 'project'
    ? resolve(process.cwd(), '.opencode', 'agents')
    : resolve(homedir(), '.config', 'opencode', 'agents');

const configDir = targetPath !== null
  ? targetPath
  : scope === 'project'
    ? process.cwd()
    : resolve(homedir(), '.config', 'opencode');

// Check for JSONC before any file writes
const jsoncPath = join(configDir, 'opencode.jsonc');
if (existsSync(jsoncPath)) {
  console.error('This installer does not support JSONC configuration. Please use opencode.json instead.');
  process.exit(1);
}

// Config patching/creation (project scope and --target only)
let configPatched = false;
let configCreated = false;
const jsonPath = join(configDir, 'opencode.json');

if (scope === 'project' || targetPath !== null) {
  const denyEntries = [
    ['agent', 'build', 'permission', 'task', 'sof-*'],
    ['agent', 'build', 'permission', 'task', 'flow'],
    ['agent', 'plan', 'permission', 'task', 'sof-*'],
    ['agent', 'plan', 'permission', 'task', 'flow'],
  ];

  if (existsSync(jsonPath)) {
    let config;
    try {
      const raw = readFileSync(jsonPath, 'utf-8');
      config = JSON.parse(raw);
    } catch (e) {
      console.error(`Error: Invalid JSON in ${jsonPath}: ${e.message}`);
      process.exit(1);
    }

    for (const path of denyEntries) {
      let current = config;
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (current[key] === undefined) {
          current[key] = {};
        } else if (typeof current[key] !== 'object' || current[key] === null) {
          console.error(`Error: Non-object value at path "${path.slice(0, i + 1).join('.')}" in ${jsonPath}`);
          process.exit(1);
        }
        current = current[key];
      }
      current[path[path.length - 1]] = 'deny';
    }

    if (!dryRun) {
      writeFileSync(jsonPath, JSON.stringify(config, null, 2) + '\n');
    }
    configPatched = true;
  } else {
    const config = {};

    for (const path of denyEntries) {
      let current = config;
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (current[key] === undefined) {
          current[key] = {};
        }
        current = current[key];
      }
      current[path[path.length - 1]] = 'deny';
    }

    if (!dryRun) {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(jsonPath, JSON.stringify(config, null, 2) + '\n');
    }
    configCreated = true;
  }
}

// Copy files
for (const file of sourceFiles) {
  const srcPath = join(SOURCE_DIR, file);
  const destPath = join(targetDir, file);

  if (dryRun) {
    console.log(`[DRY-RUN] Copy ${srcPath} -> ${destPath}`);
  } else {
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    cpSync(srcPath, destPath);
    console.log(`Copied ${srcPath} -> ${destPath}`);
  }
}

// Copy support documents (separate from agents; non-authoritative references)
if (hasSupportDocs) {
  const supportTarget = targetPath !== null
    ? resolve(targetPath, '.opencode', 'sof-support')
    : scope === 'project'
      ? resolve(process.cwd(), '.opencode', 'sof-support')
      : resolve(homedir(), '.config', 'opencode', 'sof-support');

  if (dryRun) {
    console.log(`[DRY-RUN] Copy ${SOF_SUPPORT_SOURCE}/* -> ${supportTarget}/`);
  } else {
    cpSync(SOF_SUPPORT_SOURCE, supportTarget, { recursive: true });
    console.log(`Copied ${SOF_SUPPORT_SOURCE} -> ${supportTarget}`);
  }
}

// Report config status
if (configPatched) {
  if (dryRun) {
    console.log('[DRY-RUN] Patched opencode.json with deny entries');
  } else {
    console.log('Patched opencode.json with deny entries');
  }
} else if (configCreated) {
  if (dryRun) {
    console.log('[DRY-RUN] Created opencode.json with deny entries');
  } else {
    console.log('Created opencode.json with deny entries');
  }
}

process.exit(0);
