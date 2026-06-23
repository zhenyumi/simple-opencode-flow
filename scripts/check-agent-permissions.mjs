#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const AGENTS_DIR = join(ROOT, 'agents');
const FILE_TOOLS = ['edit', 'write', 'apply_patch'];
const GLOBAL_SUPPORT_PLACEHOLDER = '<GLOBAL_SOF_SUPPORT_ROOT>';
const RENDERED_SUPPORT_ROOT = 'C:/Users/example/.config/opencode/sof-support';

const EXPECTED_AGENTS = [
  'flow.md',
  'sof-answer-repository.md',
  'sof-audit-release.md',
  'sof-design-change.md',
  'sof-execute-operation.md',
  'sof-explore-repository.md',
  'sof-implement-task.md',
  'sof-research-source.md',
  'sof-review-code.md',
  'sof-review-plan.md',
  'sof-verify-release.md',
  'sof-write-plan.md',
];

const FILE_READ_ONLY_AGENTS = [
  'sof-answer-repository.md',
  'sof-audit-release.md',
  'sof-design-change.md',
  'sof-execute-operation.md',
  'sof-explore-repository.md',
  'sof-research-source.md',
  'sof-review-code.md',
  'sof-review-plan.md',
  'sof-verify-release.md',
];

const errors = [];

function fail(message) {
  errors.push(message);
}

function parseScalar(raw) {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parsePermission(text, source) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const firstFence = lines.indexOf('---');
  const secondFence = lines.indexOf('---', firstFence + 1);
  if (firstFence !== 0 || secondFence < 0) {
    throw new Error(`${source}: missing YAML frontmatter fences`);
  }

  const permissionIndex = lines.findIndex(
    (line, index) => index > firstFence && index < secondFence && line === 'permission:',
  );
  if (permissionIndex < 0) {
    throw new Error(`${source}: missing permission block`);
  }

  const root = {};
  const stack = [{ indent: 0, value: root }];

  for (let index = permissionIndex + 1; index < secondFence; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;

    const match = line.match(/^\s+(?:"([^"]+)"|'([^']+)'|([^:]+)):\s*(.*)$/);
    if (!match) {
      throw new Error(`${source}:${index + 1}: unsupported permission syntax`);
    }

    const key = (match[1] ?? match[2] ?? match[3]).trim();
    const rawValue = match[4];

    while (stack.length > 1 && stack.at(-1).indent >= indent) {
      stack.pop();
    }
    const parent = stack.at(-1).value;

    if (rawValue === '') {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }

  return root;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

function wildcardMatch(input, pattern) {
  const normalizedInput = normalizePath(input);
  let escaped = normalizePath(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  if (escaped.endsWith(' .*')) {
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  }

  return new RegExp(`^${escaped}$`, 'si').test(normalizedInput);
}

function evaluate(rule, target) {
  if (typeof rule === 'string') return rule;
  let result = 'ask';
  for (const [pattern, action] of Object.entries(rule)) {
    if (wildcardMatch(target, pattern)) result = action;
  }
  return result;
}

function normalizeRenderedSupport(value) {
  if (typeof value === 'string') {
    return value.replaceAll(RENDERED_SUPPORT_ROOT, GLOBAL_SUPPORT_PLACEHOLDER);
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key.replaceAll(RENDERED_SUPPORT_ROOT, GLOBAL_SUPPORT_PLACEHOLDER),
      normalizeRenderedSupport(child),
    ]),
  );
}

function assertMirrored(agentName, permission) {
  const baseline = permission.edit;
  for (const tool of FILE_TOOLS) {
    if (!same(permission[tool], baseline)) {
      fail(`${agentName}: ${tool} rules must exactly mirror edit rules`);
    }
  }
}

function assertAction(agentName, permission, target, expected) {
  for (const tool of FILE_TOOLS) {
    const actual = evaluate(permission[tool], target);
    if (actual !== expected) {
      fail(`${agentName}: ${tool} ${target} expected ${expected}, got ${actual}`);
    }
  }
}

const agentFiles = readdirSync(AGENTS_DIR)
  .filter((name) => name.endsWith('.md'))
  .sort();

if (!same(agentFiles, [...EXPECTED_AGENTS].sort())) {
  fail(`agent inventory mismatch: found [${agentFiles.join(', ')}]`);
}

const agents = new Map();
for (const name of agentFiles) {
  const path = join(AGENTS_DIR, name);
  const text = readFileSync(path, 'utf8');
  const permission = parsePermission(text, name);
  agents.set(name, { text, permission });
  assertMirrored(name, permission);

  const rendered = text.replaceAll(GLOBAL_SUPPORT_PLACEHOLDER, RENDERED_SUPPORT_ROOT);
  const renderedPermission = normalizeRenderedSupport(parsePermission(rendered, `rendered ${name}`));
  if (!same(permission, renderedPermission)) {
    fail(`${name}: global installer rendering changes permission semantics`);
  }
}

for (const name of FILE_READ_ONLY_AGENTS) {
  const permission = agents.get(name)?.permission;
  if (!permission) continue;
  for (const tool of FILE_TOOLS) {
    if (permission[tool] !== 'deny') {
      fail(`${name}: ${tool} must be denied`);
    }
  }
}

const flow = agents.get('flow.md');
const writer = agents.get('sof-write-plan.md');
const implementer = agents.get('sof-implement-task.md');
const operation = agents.get('sof-execute-operation.md');
const verifier = agents.get('sof-verify-release.md');

if (writer?.permission.bash !== 'deny') {
  fail('sof-write-plan.md: bash must be denied');
}

const standardArtifacts = [
  '.opencode/plans/2026-06-23-example/plan.md',
  '.opencode/plans/2026-06-23-example/evidence.md',
  '.opencode/plans/2026-06-23-example/state.md',
];
const prefixedArtifacts = standardArtifacts.map((path) => `Codex/project/${path}`);

for (const target of [...standardArtifacts, ...prefixedArtifacts]) {
  assertAction('sof-write-plan.md', writer.permission, target, 'allow');
}
assertAction('sof-write-plan.md', writer.permission, 'README.md', 'deny');
assertAction(
  'sof-write-plan.md',
  writer.permission,
  '.opencode/plans/2026-06-23-example/notes.md',
  'deny',
);
assertAction(
  'sof-write-plan.md',
  writer.permission,
  `${GLOBAL_SUPPORT_PLACEHOLDER}/registry.md`,
  'deny',
);

for (const target of [
  '.opencode/plans/2026-06-23-example/state.md',
  'Codex/project/.opencode/plans/2026-06-23-example/state.md',
]) {
  assertAction('flow.md', flow.permission, target, 'allow');
}
for (const target of [
  '.opencode/plans/2026-06-23-example/plan.md',
  'Codex/project/.opencode/plans/2026-06-23-example/evidence.md',
  'src/index.js',
]) {
  assertAction('flow.md', flow.permission, target, 'deny');
}

for (const target of [
  '.opencode/plans/2026-06-23-example/plan.md',
  'Codex/project/.opencode/plans/2026-06-23-example/state.md',
  `${GLOBAL_SUPPORT_PLACEHOLDER}/registry.md`,
]) {
  assertAction('sof-implement-task.md', implementer.permission, target, 'deny');
}
assertAction('sof-implement-task.md', implementer.permission, 'src/index.js', 'allow');

if (!flow.text.includes('never initializes or recreates a missing `state.md`')) {
  fail('flow.md: missing explicit prohibition on initializing a missing state.md');
}
if (!flow.text.includes('A missing plan-artifact creation or edit capability is never an `OPERATION`')) {
  fail('flow.md: missing workflow-artifact operation fallback prohibition');
}
if (!writer.text.includes("file tools create missing parent directories")) {
  fail('sof-write-plan.md: missing file-tool directory creation guidance');
}
if (!operation.text.includes('This prohibition applies equally to file tools, Bash')) {
  fail('sof-execute-operation.md: missing Bash workflow-artifact prohibition');
}
if (!verifier.text.includes('Bash freedom never authorizes creating, repairing, or modifying')) {
  fail('sof-verify-release.md: missing Bash workflow-artifact prohibition');
}

if (errors.length) {
  console.error(`Agent permission checks failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Agent permission checks passed: ${agentFiles.length} agents, mirrored file tools, standard/prefixed paths, and rendered installs.`,
);
