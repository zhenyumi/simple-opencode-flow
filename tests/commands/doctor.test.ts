// Tests for doctor command: diagnoses protection levels and installation state.
// Minimum 11 test cases as required by plan.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdir,
  writeFile,
  rm,
  readFile,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  runDoctor,
  type DoctorReport,
  type CommandRunner,
} from "../../src/commands/doctor.js";
import {
  writeManifest,
  createManifest,
  addAgentEntry,
  type Manifest,
  type ManifestEntry,
  MANIFEST_SCHEMA_VERSION,
} from "../../src/core/manifest.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `sof-doctor-test-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function makeConfigWithDenyRules(): string {
  return JSON.stringify(
    {
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "deny",
              flow: "deny",
            },
          },
        },
        plan: {
          permission: {
            task: {
              "sof-*": "deny",
              flow: "deny",
            },
          },
        },
      },
    },
    null,
    2
  );
}

function makeConfigWithoutDenyRules(): string {
  return JSON.stringify(
    {
      agent: {
        build: {
          permission: {
            task: {
              custom: "allow",
            },
          },
        },
        plan: {
          permission: {
            task: {
              custom: "allow",
            },
          },
        },
      },
    },
    null,
    2
  );
}

function makeConfigWithOverride(): string {
  return JSON.stringify(
    {
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "deny",
              flow: "deny",
              "*": "allow",
            },
          },
        },
        plan: {
          permission: {
            task: {
              "sof-*": "deny",
              flow: "deny",
              "*": "allow",
            },
          },
        },
      },
    },
    null,
    2
  );
}

function makeConfigWithOverrideLast(): string {
  return JSON.stringify(
    {
      agent: {
        build: {
          permission: {
            task: {
              "*": "allow",
              "sof-*": "deny",
              flow: "deny",
            },
          },
        },
        plan: {
          permission: {
            task: {
              "*": "allow",
              "sof-*": "deny",
              flow: "deny",
            },
          },
        },
      },
    },
    null,
    2
  );
}

function makeAgentEntry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    agentName: "sof-explore-repository",
    installedPath: ".opencode/agents/sof-explore-repository.md",
    sourceHash: "abc123",
    installedAt: "2026-06-12T00:00:00.000Z",
    managedBy: "sof",
    configRules: [],
    scalarConversion: null,
    createdAncestors: [],
    createdConfigFile: null,
    initialConfigState: null,
    configPath: "opencode.json",
    lastWrittenStateFingerprint: "def456",
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    installerVersion: "0.1.0",
    ...overrides,
  };
}

async function setupProjectDir(
  tmpDir: string,
  configContent?: string,
  manifest?: Manifest,
  agentFiles?: string[]
): Promise<void> {
  // Create .opencode structure
  await mkdir(join(tmpDir, ".opencode", "agents"), { recursive: true });

  // Write config if provided
  if (configContent) {
    await writeFile(join(tmpDir, "opencode.json"), configContent, "utf-8");
  }

  // Write manifest if provided
  if (manifest) {
    await writeManifest(tmpDir, manifest);
  }

  // Create agent files if provided
  if (agentFiles) {
    for (const file of agentFiles) {
      await writeFile(
        join(tmpDir, ".opencode", "agents", file),
        `# ${file}\nAgent content`,
        "utf-8"
      );
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("doctor", () => {
  let tmpDir: string;
  let noOpCommandRunner: CommandRunner;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    // Command runner that always fails (opencode not available)
    noOpCommandRunner = async () => {
      throw new Error("opencode not found");
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Test 1: Selected-scope: correctly patched config → PASS ──────────────

  it("1. Selected-scope: correctly patched config → PASS", async () => {
    await setupProjectDir(tmpDir, makeConfigWithDenyRules());

    const report = await runDoctor(
      { projectDir: tmpDir },
      noOpCommandRunner
    );

    expect(report.selectedScope.status).toBe("PASS");
    expect(report.selectedScope.level).toBe("selected-scope");
    expect(report.selectedScope.agents).toHaveLength(9); // 8 renamed + flow
    for (const agent of report.selectedScope.agents) {
      expect(agent.buildTask).toBe("PASS");
      expect(agent.planTask).toBe("PASS");
    }
  });

  // ── Test 2: Selected-scope: missing deny rule → FAIL with detail ─────────

  it("2. Selected-scope: missing deny rule → FAIL with detail", async () => {
    await setupProjectDir(tmpDir, makeConfigWithoutDenyRules());

    const report = await runDoctor(
      { projectDir: tmpDir },
      noOpCommandRunner
    );

    expect(report.selectedScope.status).toBe("FAIL");
    expect(report.selectedScope.agents).toHaveLength(9);
    for (const agent of report.selectedScope.agents) {
      expect(agent.buildTask).toBe("FAIL");
      expect(agent.planTask).toBe("FAIL");
      expect(agent.detail).toBeDefined();
    }
  });

  // ── Test 3: Selected-scope: last-match-wins denies agent → PASS ──────────

  it("3. Selected-scope: last-match-wins with deny rules last → PASS", async () => {
    await setupProjectDir(tmpDir, makeConfigWithOverrideLast());

    const report = await runDoctor(
      { projectDir: tmpDir },
      noOpCommandRunner
    );

    expect(report.selectedScope.status).toBe("PASS");
    for (const agent of report.selectedScope.agents) {
      expect(agent.buildTask).toBe("PASS");
      expect(agent.planTask).toBe("PASS");
    }
  });

  // ── Test 4: Plugin-free resolved: mocked recognized output → PASS ────────

  it("4. Plugin-free resolved: mocked output with recognized structure → PASS", async () => {
    await setupProjectDir(tmpDir, makeConfigWithDenyRules());

    const mockOutput = JSON.stringify({
      agent: {
        build: {
          permission: {
            task: { "sof-*": "deny", flow: "deny" },
          },
        },
        plan: {
          permission: {
            task: { "sof-*": "deny", flow: "deny" },
          },
        },
      },
    });

    const mockRunner: CommandRunner = async (cmd, args) => {
      expect(cmd).toBe("opencode");
      expect(args).toEqual(["debug", "config", "--pure"]);
      return { stdout: mockOutput, stderr: "" };
    };

    const report = await runDoctor({ projectDir: tmpDir }, mockRunner);

    expect(report.pluginFreeResolved.status).toBe("PASS");
    expect(report.pluginFreeResolved.level).toBe("plugin-free-resolved");
    for (const agent of report.pluginFreeResolved.agents) {
      expect(agent.buildTask).toBe("PASS");
      expect(agent.planTask).toBe("PASS");
    }
  });

  // ── Test 5: Plugin-free resolved: mocked unrecognized JSON → UNKNOWN ─────

  it("5. Plugin-free resolved: mocked output with unrecognized JSON structure → UNKNOWN", async () => {
    await setupProjectDir(tmpDir, makeConfigWithDenyRules());

    const mockOutput = JSON.stringify({
      someOtherStructure: { key: "value" },
    });

    const mockRunner: CommandRunner = async () => {
      return { stdout: mockOutput, stderr: "" };
    };

    const report = await runDoctor({ projectDir: tmpDir }, mockRunner);

    expect(report.pluginFreeResolved.status).toBe("UNKNOWN");
    expect(report.pluginFreeResolved.detail).toContain("Unrecognized JSON structure");
  });

  // ── Test 6: Plugin-free resolved: opencode unavailable → UNAVAILABLE ─────

  it("6. Plugin-free resolved: opencode unavailable → UNAVAILABLE", async () => {
    await setupProjectDir(tmpDir, makeConfigWithDenyRules());

    const report = await runDoctor(
      { projectDir: tmpDir },
      noOpCommandRunner
    );

    expect(report.pluginFreeResolved.status).toBe("UNAVAILABLE");
    expect(report.pluginFreeResolved.detail).toContain("opencode not found");
  });

  // ── Test 7: Runtime: --runtime not specified → reports UNKNOWN ────────────

  it("7. Runtime: --runtime not specified → reports UNKNOWN for runtime level", async () => {
    await setupProjectDir(tmpDir, makeConfigWithDenyRules());

    const report = await runDoctor(
      { projectDir: tmpDir },
      noOpCommandRunner
    );

    expect(report.runtime.status).toBe("UNKNOWN");
    expect(report.runtime.level).toBe("runtime");
    expect(report.runtime.detail).toContain("--runtime not specified");
  });

  // ── Test 8: Runtime: --runtime with mocked recognized output → PASS ──────

  it("8. Runtime: --runtime with mocked recognized output → PASS", async () => {
    await setupProjectDir(tmpDir, makeConfigWithDenyRules());

    const mockOutput = JSON.stringify({
      agent: {
        build: {
          permission: {
            task: { "sof-*": "deny", flow: "deny" },
          },
        },
        plan: {
          permission: {
            task: { "sof-*": "deny", flow: "deny" },
          },
        },
      },
    });

    const mockRunner: CommandRunner = async (cmd, args) => {
      expect(cmd).toBe("opencode");
      expect(args).toEqual(["debug", "config"]);
      return { stdout: mockOutput, stderr: "" };
    };

    const report = await runDoctor(
      { projectDir: tmpDir, runtime: true },
      mockRunner
    );

    expect(report.runtime.status).toBe("PASS");
    expect(report.runtime.level).toBe("runtime");
    for (const agent of report.runtime.agents) {
      expect(agent.buildTask).toBe("PASS");
      expect(agent.planTask).toBe("PASS");
    }
  });

  // ── Test 9: No config file present → all levels FAIL/UNAVAILABLE/UNKNOWN ─

  it("9. No config file present → all levels FAIL/UNAVAILABLE/UNKNOWN appropriately", async () => {
    // No config written
    await setupProjectDir(tmpDir, undefined, undefined, ["sof-explore-repository.md"]);

    const report = await runDoctor(
      { projectDir: tmpDir },
      noOpCommandRunner
    );

    expect(report.selectedScope.status).toBe("FAIL");
    expect(report.selectedScope.detail).toContain("Config file not found");
    expect(report.pluginFreeResolved.status).toBe("UNAVAILABLE");
    expect(report.runtime.status).toBe("UNKNOWN");
  });

  // ── Test 10: Installation inconsistency: missing managed agent → WARN/FAIL ─

  it("10. Installation inconsistency: missing managed agent → WARN/FAIL", async () => {
    const agentsDir = join(tmpDir, ".opencode", "agents");
    await mkdir(agentsDir, { recursive: true });

    // Create manifest with an agent entry
    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        installedPath: join(agentsDir, "sof-explore-repository.md"),
        sourceHash: "abc123",
      })
    );

    await setupProjectDir(tmpDir, makeConfigWithDenyRules(), manifest);
    // Don't create the agent file — it's missing

    const report = await runDoctor(
      { projectDir: tmpDir },
      noOpCommandRunner
    );

    const missingAgent = report.inconsistencies.find(
      (i) => i.type === "missing-agent-file"
    );
    expect(missingAgent).toBeDefined();
    expect(missingAgent!.severity).toBe("FAIL");
    expect(missingAgent!.detail).toContain("sof-explore-repository.md");
  });

  // ── Test 11: Backup directory paths reported when present ────────────────

  it("11. Backup directory paths reported when present", async () => {
    // Create backup directories
    const backupDir1 = join(
      tmpDir,
      ".opencode",
      ".sof-backups-2026-06-12_00-00-00-000-abcdef12"
    );
    const backupDir2 = join(
      tmpDir,
      ".opencode",
      ".sof-backups-2026-06-12_01-00-00-000-fedcba21"
    );
    await mkdir(backupDir1, { recursive: true });
    await mkdir(backupDir2, { recursive: true });

    await setupProjectDir(tmpDir, makeConfigWithDenyRules());

    const report = await runDoctor(
      { projectDir: tmpDir },
      noOpCommandRunner
    );

    expect(report.backupPaths).toHaveLength(2);
    expect(report.backupPaths).toContain(backupDir1);
    expect(report.backupPaths).toContain(backupDir2);
  });

  // ── Test 12 (bonus): Last-match-wins with override before deny → WARN ────

  it("12. Last-match-wins: deny rules before override → WARN", async () => {
    // Config with deny rules BEFORE override ("*" follows)
    const configContent = JSON.stringify(
      {
        agent: {
          build: {
            permission: {
              task: {
                "sof-*": "deny",
                flow: "deny",
                "*": "allow",
              },
            },
          },
          plan: {
            permission: {
              task: {
                "sof-*": "deny",
                flow: "deny",
                "*": "allow",
              },
            },
          },
        },
      },
      null,
      2
    );
    await setupProjectDir(tmpDir, configContent);

    const report = await runDoctor(
      { projectDir: tmpDir },
      noOpCommandRunner
    );

    // Last-match-wins: "*" comes after deny rules → override takes effect → WARN
    expect(report.selectedScope.status).toBe("WARN");
    for (const agent of report.selectedScope.agents) {
      expect(agent.buildTask).toBe("WARN");
      expect(agent.planTask).toBe("WARN");
    }
  });

  // ── Test 13 (bonus): Hash mismatch detected ──────────────────────────────

  it("13. Hash mismatch detected → WARN inconsistency", async () => {
    const agentsDir = join(tmpDir, ".opencode", "agents");
    await mkdir(agentsDir, { recursive: true });

    // Create agent file
    const agentFile = join(agentsDir, "sof-explore-repository.md");
    await writeFile(agentFile, "# Agent content", "utf-8");

    // Create manifest with wrong hash
    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        installedPath: agentFile,
        sourceHash: "wrong-hash-value",
      })
    );

    await setupProjectDir(tmpDir, makeConfigWithDenyRules(), manifest);

    const report = await runDoctor(
      { projectDir: tmpDir },
      noOpCommandRunner
    );

    const hashMismatch = report.inconsistencies.find(
      (i) => i.type === "hash-mismatch"
    );
    expect(hashMismatch).toBeDefined();
    expect(hashMismatch!.severity).toBe("WARN");
    expect(hashMismatch!.detail).toContain("Hash mismatch");
  });

  // ── Test 14 (bonus): No manifest → WARN inconsistency ────────────────────

  it("14. No manifest → WARN inconsistency", async () => {
    await setupProjectDir(tmpDir, makeConfigWithDenyRules());
    // No manifest written

    const report = await runDoctor(
      { projectDir: tmpDir },
      noOpCommandRunner
    );

    const noManifest = report.inconsistencies.find(
      (i) => i.type === "no-manifest"
    );
    expect(noManifest).toBeDefined();
    expect(noManifest!.severity).toBe("WARN");
  });

  // ── Test 15 (bonus): Runtime with unrecognized output → UNKNOWN ──────────

  it("15. Runtime: --runtime with unrecognized output → UNKNOWN", async () => {
    await setupProjectDir(tmpDir, makeConfigWithDenyRules());

    const mockRunner: CommandRunner = async () => {
      return {
        stdout: JSON.stringify({ unrecognized: "structure" }),
        stderr: "",
      };
    };

    const report = await runDoctor(
      { projectDir: tmpDir, runtime: true },
      mockRunner
    );

    expect(report.runtime.status).toBe("UNKNOWN");
    expect(report.runtime.detail).toContain("Unrecognized JSON structure");
  });

  // ── Test 16 (bonus): Runtime with invalid JSON → UNKNOWN ─────────────────

  it("16. Runtime: --runtime with invalid JSON output → UNKNOWN", async () => {
    await setupProjectDir(tmpDir, makeConfigWithDenyRules());

    const mockRunner: CommandRunner = async () => {
      return { stdout: "not valid json {{{", stderr: "" };
    };

    const report = await runDoctor(
      { projectDir: tmpDir, runtime: true },
      mockRunner
    );

    expect(report.runtime.status).toBe("UNKNOWN");
    expect(report.runtime.detail).toContain("not valid JSON");
  });
});
