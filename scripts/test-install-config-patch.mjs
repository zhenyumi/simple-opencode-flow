#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const installer = join(repoRoot, 'scripts', 'install.mjs');

function runInstall(target) {
  return spawnSync(process.execPath, [installer, '--target', target], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const tempRoot = mkdtempSync(join(tmpdir(), 'sof-install-test-'));

try {
  const target = join(tempRoot, 'project');
  const configPath = join(target, 'opencode.json');
  mkdirSync(target, { recursive: true });
  const originalConfig = {
    theme: 'quiet',
    agent: {
      build: {
        permission: {
          task: {
            existing: 'allow',
          },
        },
        notes: ['keep-me'],
      },
      plan: {
        permission: {
          task: {
            unrelated: 'ask',
          },
        },
      },
      custom: {
        permission: {
          task: {
            own: 'allow',
          },
        },
      },
    },
    unrelated: {
      nested: true,
    },
  };

  writeFileSync(configPath, JSON.stringify(originalConfig, null, 2) + '\n');

  const first = runInstall(target);
  assert.equal(first.status, 0, first.stderr || first.stdout);

  const patched = readJson(configPath);
  assert.equal(patched.theme, 'quiet');
  assert.deepEqual(patched.unrelated, { nested: true });
  assert.deepEqual(patched.agent.custom, originalConfig.agent.custom);
  assert.deepEqual(patched.agent.build.notes, ['keep-me']);
  assert.equal(patched.agent.build.permission.task.existing, 'allow');
  assert.equal(patched.agent.plan.permission.task.unrelated, 'ask');
  assert.equal(patched.agent.build.permission.task['sof-*'], 'deny');
  assert.equal(patched.agent.build.permission.task.flow, 'deny');
  assert.equal(patched.agent.plan.permission.task['sof-*'], 'deny');
  assert.equal(patched.agent.plan.permission.task.flow, 'deny');
  assert.equal(existsSync(join(target, '.opencode', 'agents', 'flow.md')), true);
  assert.equal(existsSync(join(target, '.opencode', 'agents', 'sof-answer-repository.md')), true);
  assert.equal(existsSync(join(target, '.opencode', 'agents', 'sof-execute-operation.md')), true);

  const afterFirst = readFileSync(configPath, 'utf8');
  const second = runInstall(target);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const afterSecond = readFileSync(configPath, 'utf8');
  assert.equal(afterSecond, afterFirst);

  const badTarget = join(tempRoot, 'bad-project');
  const badConfigPath = join(badTarget, 'opencode.json');
  mkdirSync(badTarget, { recursive: true });
  const badRaw = JSON.stringify({ agent: { build: 'not-an-object' }, keep: 'unchanged' }, null, 2) + '\n';
  writeFileSync(badConfigPath, badRaw);

  const failed = runInstall(badTarget);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Non-object value/);
  assert.equal(readFileSync(badConfigPath, 'utf8'), badRaw);

  console.log('install config patch test passed');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
