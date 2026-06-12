#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(__dirname, '..', 'agents');

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
  --target <path>           Install to a custom directory (mutually exclusive with --scope)
  --dry-run                 Show planned operations without executing
  --help                    Show this help message

Examples:
  node scripts/install.mjs --scope project
  node scripts/install.mjs --scope global
  node scripts/install.mjs --target ./my-agents
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

// Determine paths based on scope
const targetDir = targetPath !== null
  ? targetPath
  : scope === 'project'
    ? resolve(process.cwd(), '.opencode', 'agents')
    : resolve(homedir(), '.config', 'opencode', 'agents');

const configDir = scope === 'project'
  ? process.cwd()
  : resolve(homedir(), '.config', 'opencode');

// Check for JSONC before any file writes
const jsoncPath = join(configDir, 'opencode.jsonc');
if (existsSync(jsoncPath)) {
  console.error('This installer does not support JSONC configuration. Please use opencode.json instead.');
  process.exit(1);
}

// Config patching (project scope only)
let configPatched = false;
const jsonPath = join(configDir, 'opencode.json');

if (targetPath === null && scope === 'project' && existsSync(jsonPath)) {
  let config;
  try {
    const raw = readFileSync(jsonPath, 'utf-8');
    config = JSON.parse(raw);
  } catch (e) {
    console.error(`Error: Invalid JSON in ${jsonPath}: ${e.message}`);
    process.exit(1);
  }

  // Deep merge deny entries
  const denyEntries = [
    ['agent', 'build', 'permission', 'task', 'sof-*'],
    ['agent', 'build', 'permission', 'task', 'flow'],
    ['agent', 'plan', 'permission', 'task', 'sof-*'],
    ['agent', 'plan', 'permission', 'task', 'flow'],
  ];

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

// Report config patch status
if (configPatched) {
  if (dryRun) {
    console.log('[DRY-RUN] Patched opencode.json with deny entries');
  } else {
    console.log('Patched opencode.json with deny entries');
  }
} else if (targetPath === null && scope === 'project') {
  console.log('Skipped config patch (opencode.json not found — add deny entries manually; see README for manual install guide)');
}

process.exit(0);
