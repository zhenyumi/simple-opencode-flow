// Doctor command: diagnoses protection levels and installation state without modifying anything.
// Three protection levels: selected-scope, plugin-free resolved, runtime.
// No auto-repair, no --level flag, no interactive prompts.

import { resolve, join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseTree, findNodeAtLocation, getNodeValue } from "jsonc-parser";
import { resolveScope } from "../core/project-root.js";
import { readManifest, isManaged } from "../core/manifest.js";
import { findBackupDirs } from "../core/operations.js";
import { computeHash } from "../core/agents.js";
import type { DoctorOptions, Manifest, ManifestEntry } from "../types.js";

const execFileAsync = promisify(execFile);

// ─── Constants ───────────────────────────────────────────────────────────────

const MANAGED_DENY_KEYS = ["sof-*", "flow"] as const;
const MANAGED_DENY_VALUE = "deny";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProtectionStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN" | "UNAVAILABLE";

export interface AgentProtectionResult {
  agentName: string;
  buildTask: ProtectionStatus;
  planTask: ProtectionStatus;
  detail?: string;
}

export interface ProtectionLevelResult {
  level: string;
  status: ProtectionStatus;
  agents: AgentProtectionResult[];
  detail?: string;
}

export interface InconsistencyResult {
  type: string;
  severity: "INFO" | "WARN" | "FAIL";
  detail: string;
}

export interface DoctorReport {
  selectedScope: ProtectionLevelResult;
  pluginFreeResolved: ProtectionLevelResult;
  runtime: ProtectionLevelResult;
  inconsistencies: InconsistencyResult[];
  backupPaths: string[];
}

export type CommandRunner = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

// ─── Default command runner ──────────────────────────────────────────────────

async function defaultRunCommand(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: 30000,
  });
  return { stdout, stderr };
}

// ─── Helper: resolve scope ───────────────────────────────────────────────────

async function resolveScopeFromOptions(options: DoctorOptions) {
  return resolveScope({
    project: options.projectDir,
    global: options.global,
  });
}

// ─── Helper: get all managed agent names ─────────────────────────────────────

function getAllManagedAgentNames(): string[] {
  // 8 renamed agents from agents.ts getRenameMap()
  const renamedAgents = [
    "sof-explore-repository",
    "sof-design-change",
    "sof-write-plan",
    "sof-review-plan",
    "sof-implement-task",
    "sof-review-code",
    "sof-verify-release",
    "sof-audit-release",
  ];
  // flow.md is also installed (not renamed)
  return [...renamedAgents, "flow"];
}

// ─── Helper: navigate parsed JSON object ─────────────────────────────────────

function getNestedValue(
  obj: Record<string, unknown>,
  path: string[]
): unknown {
  let current: unknown = obj;
  for (const segment of path) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

// ─── Helper: last-match-wins evaluation ──────────────────────────────────────

function evaluateAgentPermission(
  taskPolicy: Record<string, unknown>,
  agentName: string
): ProtectionStatus {
  const entries = Object.entries(taskPolicy);
  if (entries.length === 0) return "FAIL";

  let effectivePermission: string | undefined;

  for (const [key, value] of entries) {
    if (typeof value !== "string") continue;

    // Exact match
    if (key === agentName) {
      effectivePermission = value;
      continue;
    }

    // Glob pattern: key ends with "*"
    if (key.endsWith("*")) {
      const prefix = key.slice(0, -1);
      if (agentName.startsWith(prefix)) {
        effectivePermission = value;
      }
    }
  }

  if (effectivePermission === undefined) return "FAIL";
  return effectivePermission === MANAGED_DENY_VALUE ? "PASS" : "WARN";
}

// ─── Helper: evaluate task policies for all agents ───────────────────────────

function evaluateTaskPolicies(
  buildPolicy: Record<string, unknown>,
  planPolicy: Record<string, unknown>,
  managedAgents: string[]
): AgentProtectionResult[] {
  const results: AgentProtectionResult[] = [];

  for (const agentName of managedAgents) {
    const buildStatus = evaluateAgentPermission(buildPolicy, agentName);
    const planStatus = evaluateAgentPermission(planPolicy, agentName);

    const detailParts: string[] = [];
    if (buildStatus !== "PASS") {
      detailParts.push(`Build: ${buildStatus}`);
    }
    if (planStatus !== "PASS") {
      detailParts.push(`Plan: ${planStatus}`);
    }

    results.push({
      agentName,
      buildTask: buildStatus,
      planTask: planStatus,
      detail: detailParts.length > 0 ? detailParts.join("; ") : undefined,
    });
  }

  return results;
}

// ─── Helper: determine overall level status ──────────────────────────────────

function determineLevelStatus(agents: AgentProtectionResult[]): ProtectionStatus {
  const statuses = agents.flatMap((a) => [a.buildTask, a.planTask]);
  if (statuses.every((s) => s === "PASS")) return "PASS";
  if (statuses.some((s) => s === "FAIL")) return "FAIL";
  if (statuses.some((s) => s === "WARN")) return "WARN";
  return "UNKNOWN";
}

// ─── Helper: read and parse config file directly ─────────────────────────────

async function readAndParseConfig(
  configPath: string
): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(configPath, "utf-8");
    const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    const tree = parseTree(text, [], {
      disallowComments: false,
      allowTrailingComma: true,
    });
    if (!tree) return null;
    return getNodeValue(tree) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Helper: evaluate a parsed config object ─────────────────────────────────

function evaluateParsedConfig(
  parsed: Record<string, unknown>,
  managedAgents: string[],
  levelName: string
): ProtectionLevelResult {
  const buildPolicy = getNestedValue(parsed, [
    "agent",
    "build",
    "permission",
    "task",
  ]);
  const planPolicy = getNestedValue(parsed, [
    "agent",
    "plan",
    "permission",
    "task",
  ]);

  const buildIsObject =
    buildPolicy && typeof buildPolicy === "object" && !Array.isArray(buildPolicy);
  const planIsObject =
    planPolicy && typeof planPolicy === "object" && !Array.isArray(planPolicy);

  if (!buildIsObject || !planIsObject) {
    return {
      level: levelName,
      status: "FAIL",
      agents: [],
      detail: `Task policy not found or not an object (build: ${typeof buildPolicy}, plan: ${typeof planPolicy})`,
    };
  }

  const agents = evaluateTaskPolicies(
    buildPolicy as Record<string, unknown>,
    planPolicy as Record<string, unknown>,
    managedAgents
  );
  const status = determineLevelStatus(agents);

  return { level: levelName, status, agents };
}

// ─── Main doctor function ────────────────────────────────────────────────────

export async function runDoctor(
  options: DoctorOptions = {},
  runCommand: CommandRunner = defaultRunCommand
): Promise<DoctorReport> {
  const managedAgents = getAllManagedAgentNames();

  // 1. Resolve scope
  const scope = await resolveScopeFromOptions(options);
  const { configPath, agentsDir, rootDir } = scope;

  // 2. Read manifest
  let manifest: Manifest | null = null;
  try {
    manifest = await readManifest(rootDir);
  } catch {
    // Manifest corrupt or missing — will be reported in inconsistencies
  }

  // ─── Level 1: Selected-scope protection ──────────────────────────────────
  const selectedScope = await checkSelectedScope(configPath, managedAgents);

  // ─── Level 2: Plugin-free resolved protection ───────────────────────────
  const pluginFreeResolved = await checkPluginFreeResolved(
    managedAgents,
    runCommand
  );

  // ─── Level 3: Runtime protection ────────────────────────────────────────
  const runtime = await checkRuntime(options, managedAgents, runCommand);

  // ─── Installation inconsistencies ───────────────────────────────────────
  const inconsistencies = await checkInstallationInconsistencies(
    manifest,
    agentsDir,
    configPath
  );

  // ─── Backup paths ──────────────────────────────────────────────────────
  const backupPaths = await findBackupDirs(rootDir);

  return {
    selectedScope,
    pluginFreeResolved,
    runtime,
    inconsistencies,
    backupPaths,
  };
}

// ─── Level 1: Selected-scope ─────────────────────────────────────────────────

async function checkSelectedScope(
  configPath: string,
  managedAgents: string[]
): Promise<ProtectionLevelResult> {
  try {
    await access(configPath);
  } catch {
    return {
      level: "selected-scope",
      status: "FAIL",
      agents: [],
      detail: `Config file not found: ${configPath}`,
    };
  }

  const parsed = await readAndParseConfig(configPath);
  if (!parsed) {
    return {
      level: "selected-scope",
      status: "FAIL",
      agents: [],
      detail: "Failed to parse config file",
    };
  }

  return evaluateParsedConfig(parsed, managedAgents, "selected-scope");
}

// ─── Level 2: Plugin-free resolved ───────────────────────────────────────────

async function checkPluginFreeResolved(
  managedAgents: string[],
  runCommand: CommandRunner
): Promise<ProtectionLevelResult> {
  let stdout: string;
  try {
    const result = await runCommand("opencode", ["debug", "config", "--pure"]);
    stdout = result.stdout;
  } catch {
    return {
      level: "plugin-free-resolved",
      status: "UNAVAILABLE",
      agents: [],
      detail: "opencode not found or --pure not supported",
    };
  }

  return parseResolvedOutput(stdout, managedAgents, "plugin-free-resolved");
}

// ─── Level 3: Runtime ───────────────────────────────────────────────────────

async function checkRuntime(
  options: DoctorOptions,
  managedAgents: string[],
  runCommand: CommandRunner
): Promise<ProtectionLevelResult> {
  if (!options.runtime) {
    return {
      level: "runtime",
      status: "UNKNOWN",
      agents: [],
      detail: "--runtime not specified",
    };
  }

  let stdout: string;
  try {
    const result = await runCommand("opencode", ["debug", "config"]);
    stdout = result.stdout;
  } catch {
    return {
      level: "runtime",
      status: "UNKNOWN",
      agents: [],
      detail: "opencode debug config command failed",
    };
  }

  return parseResolvedOutput(stdout, managedAgents, "runtime");
}

// ─── Helper: parse resolved config output ────────────────────────────────────

function parseResolvedOutput(
  output: string,
  managedAgents: string[],
  levelName: string
): ProtectionLevelResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return {
      level: levelName,
      status: "UNKNOWN",
      agents: [],
      detail: "Output is not valid JSON",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      level: levelName,
      status: "UNKNOWN",
      agents: [],
      detail: "Output is not a JSON object",
    };
  }

  const parsedObj = parsed as Record<string, unknown>;

  // Check for recognized structure
  const buildPolicy = getNestedValue(parsedObj, [
    "agent",
    "build",
    "permission",
    "task",
  ]);
  const planPolicy = getNestedValue(parsedObj, [
    "agent",
    "plan",
    "permission",
    "task",
  ]);

  if (!buildPolicy || typeof buildPolicy !== "object" || Array.isArray(buildPolicy)) {
    return {
      level: levelName,
      status: "UNKNOWN",
      agents: [],
      detail: "Unrecognized JSON structure: missing agent.build.permission.task",
    };
  }
  if (!planPolicy || typeof planPolicy !== "object" || Array.isArray(planPolicy)) {
    return {
      level: levelName,
      status: "UNKNOWN",
      agents: [],
      detail: "Unrecognized JSON structure: missing agent.plan.permission.task",
    };
  }

  const agents = evaluateTaskPolicies(
    buildPolicy as Record<string, unknown>,
    planPolicy as Record<string, unknown>,
    managedAgents
  );
  const status = determineLevelStatus(agents);

  return { level: levelName, status, agents };
}

// ─── Installation inconsistencies ────────────────────────────────────────────

async function checkInstallationInconsistencies(
  manifest: Manifest | null,
  agentsDir: string,
  configPath: string
): Promise<InconsistencyResult[]> {
  const inconsistencies: InconsistencyResult[] = [];

  // Read config to check protection state
  let parsedConfig: Record<string, unknown> | null = null;
  try {
    await access(configPath);
    parsedConfig = await readAndParseConfig(configPath);
  } catch {
    // Config doesn't exist — already reported in selected-scope
  }

  if (!manifest) {
    inconsistencies.push({
      type: "no-manifest",
      severity: "WARN",
      detail: "No manifest found — installation state unknown",
    });

    // Without manifest, just check if agents directory exists
    try {
      await access(agentsDir);
    } catch {
      inconsistencies.push({
        type: "missing-agents-dir",
        severity: "FAIL",
        detail: `Agents directory not found: ${agentsDir}`,
      });
    }

    return inconsistencies;
  }

  // Check each manifest entry
  for (const [agentName, entry] of Object.entries(manifest.entries)) {
    // Check installed file exists
    const installedPath = resolve(entry.installedPath);
    let fileExists = false;
    try {
      await access(installedPath);
      fileExists = true;
    } catch {
      // File doesn't exist
    }

    if (!fileExists) {
      inconsistencies.push({
        type: "missing-agent-file",
        severity: "FAIL",
        detail: `Agent file missing: ${installedPath}`,
      });
      continue;
    }

    // Check hash
    try {
      const currentHash = await computeHash(installedPath);
      if (currentHash !== entry.sourceHash) {
        inconsistencies.push({
          type: "hash-mismatch",
          severity: "WARN",
          detail: `Hash mismatch for ${agentName}: expected ${entry.sourceHash}, got ${currentHash}`,
        });
      }
    } catch {
      inconsistencies.push({
        type: "hash-error",
        severity: "WARN",
        detail: `Could not compute hash for ${installedPath}`,
      });
    }

    // Check protection effectiveness
    if (parsedConfig) {
      const buildPolicy = getNestedValue(parsedConfig, [
        "agent",
        "build",
        "permission",
        "task",
      ]);
      const planPolicy = getNestedValue(parsedConfig, [
        "agent",
        "plan",
        "permission",
        "task",
      ]);

      const buildIsObject =
        buildPolicy &&
        typeof buildPolicy === "object" &&
        !Array.isArray(buildPolicy);
      const planIsObject =
        planPolicy &&
        typeof planPolicy === "object" &&
        !Array.isArray(planPolicy);

      if (!buildIsObject || !planIsObject) {
        inconsistencies.push({
          type: "missing-protection",
          severity: "FAIL",
          detail: `Missing or invalid Task policy for ${agentName}`,
        });
      }
    }
  }

  // Check for unexpected managed agents on disk
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(agentsDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    for (const file of mdFiles) {
      const agentName = file.replace(/\.md$/, "");
      if (!isManaged(manifest, agentName)) {
        inconsistencies.push({
          type: "unexpected-managed-agent",
          severity: "WARN",
          detail: `Unexpected managed agent file: ${file}`,
        });
      }
    }
  } catch {
    // Agents dir doesn't exist — already reported
  }

  return inconsistencies;
}
