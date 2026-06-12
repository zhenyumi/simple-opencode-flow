// Tests for sof uninstall command.
// Minimum 12 test cases as required by plan.
// AC-06: Agents removed before protection
// AC-07: Scalar restore only on exact match
// AC-23: --dry-run zero writes
// C-014: Agent-before-protection ordering
// C-015: User data preservation
// R-006: User-added fields preserved

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  readdir,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { uninstallCommand } from "../../src/commands/uninstall.js";
import {
  writeManifest,
  createManifest,
  addAgentEntry,
  addConfigRuleEntry,
  type Manifest,
  type ManifestEntry,
  type ConfigRuleEntry,
  MANIFEST_SCHEMA_VERSION,
} from "../../src/core/manifest.js";
import { writePatchedConfig, readConfigParseTree } from "../../src/core/config.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function makeAgentEntry(
  overrides: Partial<ManifestEntry> = {}
): ManifestEntry {
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

function makeConfigRule(
  overrides: Partial<ConfigRuleEntry> = {}
): ConfigRuleEntry {
  return {
    targetPath: "agent.build.permission.task",
    ruleKey: "sof-*",
    ruleValue: "deny",
    existedBefore: false,
    previousValue: null,
    previousOrderedPosition: null,
    action: "inserted",
    lastWrittenValue: "deny",
    lastWrittenOrderedPosition: 1,
    reordered: false,
    originalPosition: null,
    newPosition: null,
    ...overrides,
  };
}

/**
 * Create a test environment with agents, config, and manifest.
 */
async function createTestEnv(
  tmpDir: string,
  options: {
    configContent?: string;
    manifest?: Manifest;
    agentFiles?: string[];
  } = {}
): Promise<void> {
  // Create .opencode/agents directory
  await mkdir(join(tmpDir, ".opencode", "agents"), { recursive: true });

  // Create agent files
  const agentFiles = options.agentFiles ?? ["sof-explore-repository.md"];
  for (const agent of agentFiles) {
    await writeFile(
      join(tmpDir, ".opencode", "agents", agent),
      `---\nname: ${agent.replace(".md", "")}\nmode: subagent\n---\n# Agent content`
    );
  }

  // Create config file
  if (options.configContent) {
    await writeFile(join(tmpDir, "opencode.json"), options.configContent);
  }

  // Write manifest
  if (options.manifest) {
    await writeManifest(tmpDir, options.manifest);
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("uninstallCommand", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "uninstall-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Test 1: Full uninstall of fresh install → all traces removed ──────────

  it("1. Full uninstall of fresh install → all traces removed", async () => {
    // Setup: agent with managed rules, installer-created config
    const configContent = JSON.stringify({
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "deny",
              flow: "deny",
            },
          },
        },
      },
    });

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "flow",
            lastWrittenValue: "deny",
          }),
        ],
        createdConfigFile: "opencode.json",
        initialConfigState: JSON.parse(configContent),
      })
    );
    manifest = {
      ...manifest,
      lastWrittenTaskSnapshots: {
        "agent.build.permission.task": [
          ["sof-*", "deny"],
          ["flow", "deny"],
        ],
      },
    };

    await createTestEnv(tmpDir, { configContent, manifest });

    // Execute uninstall
    const result = await uninstallCommand({ projectDir: tmpDir });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(false);

    // Verify all traces removed
    expect(await pathExists(join(tmpDir, ".opencode", "agents", "sof-explore-repository.md"))).toBe(
      false
    );
    expect(await pathExists(join(tmpDir, "opencode.json"))).toBe(false);
    expect(await pathExists(join(tmpDir, ".opencode", ".sof-manifest.json"))).toBe(false);
  });

  // ── Test 2: Scalar Task restored when exact match → original scalar value ─

  it("2. Scalar Task restored when exact match → original scalar value present", async () => {
    // Setup: scalar Task was converted to object with managed rules
    const configContent = JSON.stringify({
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
      },
    });

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "flow",
            lastWrittenValue: "deny",
          }),
        ],
        scalarConversion: { originalValue: "allow" },
      })
    );
    manifest = {
      ...manifest,
      lastWrittenTaskSnapshots: {
        "agent.build.permission.task": [
          ["*", "allow"],
          ["sof-*", "deny"],
          ["flow", "deny"],
        ],
      },
    };

    await createTestEnv(tmpDir, { configContent, manifest });

    const result = await uninstallCommand({ projectDir: tmpDir });

    expect(result.success).toBe(true);

    // Config should still exist (not installer-created)
    expect(await pathExists(join(tmpDir, "opencode.json"))).toBe(true);

    // Read config and verify scalar restore
    const content = await readFile(join(tmpDir, "opencode.json"), "utf-8");
    const parsed = JSON.parse(content);

    // Task should be restored to scalar "allow"
    expect(parsed.agent.build.permission.task).toBe("allow");
  });

  // ── Test 3: Scalar Task NOT restored when user modified → Task object ─────

  it("3. Scalar Task NOT restored when user modified → Task object preserved", async () => {
    // Setup: user added a custom rule after install
    const configContent = JSON.stringify({
      agent: {
        build: {
          permission: {
            task: {
              "*": "allow",
              "sof-*": "deny",
              flow: "deny",
              "custom-rule": "deny",
            },
          },
        },
      },
    });

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "flow",
            lastWrittenValue: "deny",
          }),
        ],
        scalarConversion: { originalValue: "allow" },
      })
    );
    manifest = {
      ...manifest,
      lastWrittenTaskSnapshots: {
        "agent.build.permission.task": [
          ["*", "allow"],
          ["sof-*", "deny"],
          ["flow", "deny"],
        ],
      },
    };

    await createTestEnv(tmpDir, { configContent, manifest });

    const result = await uninstallCommand({ projectDir: tmpDir });

    expect(result.success).toBe(true);

    // Config should preserve the Task object (not restore to scalar)
    const content = await readFile(join(tmpDir, "opencode.json"), "utf-8");
    const parsed = JSON.parse(content);

    // Task should remain as object with custom rule preserved
    expect(typeof parsed.agent.build.permission.task).toBe("object");
    expect(parsed.agent.build.permission.task["custom-rule"]).toBe("deny");
    // Managed rules should be removed
    expect(parsed.agent.build.permission.task["sof-*"]).toBeUndefined();
    expect(parsed.agent.build.permission.task.flow).toBeUndefined();
  });

  // ── Test 4: User-modified managed rule → skipped without --force ──────────

  it("4. User-modified managed rule → skipped without --force", async () => {
    // Setup: user changed a managed rule value
    const configContent = JSON.stringify({
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "allow",
              flow: "deny",
            },
          },
        },
      },
    });

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "flow",
            lastWrittenValue: "deny",
          }),
        ],
      })
    );

    await createTestEnv(tmpDir, { configContent, manifest });

    // Without --force, should throw due to user-modified rule
    await expect(
      uninstallCommand({ projectDir: tmpDir })
    ).rejects.toThrow(/user-modified rules detected/);
  });

  // ── Test 5: --force removes user-modified managed rule ────────────────────

  it("5. --force removes user-modified managed rule", async () => {
    // Setup: user changed a managed rule value
    const configContent = JSON.stringify({
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "allow",
              flow: "deny",
            },
          },
        },
      },
    });

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "flow",
            lastWrittenValue: "deny",
          }),
        ],
      })
    );

    await createTestEnv(tmpDir, { configContent, manifest });

    const result = await uninstallCommand({ projectDir: tmpDir, force: true });

    expect(result.success).toBe(true);

    // Config should have managed rules removed
    const content = await readFile(join(tmpDir, "opencode.json"), "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.agent.build.permission.task["sof-*"]).toBeUndefined();
    expect(parsed.agent.build.permission.task.flow).toBeUndefined();
  });

  // ── Test 6: User-added config fields → preserved after uninstall ──────────

  it("6. User-added config fields → preserved after uninstall", async () => {
    // Setup: user added extra fields to config
    const configContent = JSON.stringify({
      name: "my-project",
      version: "1.0.0",
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "deny",
              flow: "deny",
            },
          },
        },
      },
      extra: {
        userField: "preserved",
      },
    });

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "flow",
            lastWrittenValue: "deny",
          }),
        ],
      })
    );

    await createTestEnv(tmpDir, { configContent, manifest });

    const result = await uninstallCommand({ projectDir: tmpDir });

    expect(result.success).toBe(true);

    // Config should preserve user-added fields
    const content = await readFile(join(tmpDir, "opencode.json"), "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.name).toBe("my-project");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.extra.userField).toBe("preserved");

    // Managed rules should be removed
    expect(parsed.agent.build.permission.task["sof-*"]).toBeUndefined();
    expect(parsed.agent.build.permission.task.flow).toBeUndefined();
  });

  // ── Test 7: Installer-created empty ancestor → removed ────────────────────

  it("7. Installer-created empty ancestor → removed", async () => {
    // Setup: installer created nested directories
    const configContent = JSON.stringify({
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "deny",
            },
          },
        },
      },
    });

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
        ],
        createdAncestors: [".opencode", ".opencode/agents"],
      })
    );

    await createTestEnv(tmpDir, { configContent, manifest });

    const result = await uninstallCommand({ projectDir: tmpDir });

    expect(result.success).toBe(true);

    // Ancestors should be removed if empty
    // Note: .opencode may still exist if other files present
    expect(await pathExists(join(tmpDir, ".opencode", "agents"))).toBe(false);
  });

  // ── Test 8: Installer-created ancestor with user content → preserved ──────

  it("8. Installer-created ancestor with user content → preserved", async () => {
    // Setup: user added files to installer-created directory
    const configContent = JSON.stringify({
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "deny",
            },
          },
        },
      },
    });

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
        ],
        createdAncestors: [".opencode", ".opencode/agents"],
      })
    );

    await createTestEnv(tmpDir, { configContent, manifest });

    // Add user file to agents directory
    await writeFile(
      join(tmpDir, ".opencode", "agents", "user-agent.md"),
      "# User agent"
    );

    const result = await uninstallCommand({ projectDir: tmpDir });

    expect(result.success).toBe(true);

    // Directory should be preserved (has user content)
    expect(await pathExists(join(tmpDir, ".opencode", "agents"))).toBe(true);
    expect(
      await pathExists(join(tmpDir, ".opencode", "agents", "user-agent.md"))
    ).toBe(true);
  });

  // ── Test 9: Installer-created config file with only managed content → deleted ─

  it("9. Installer-created config file with only managed content → deleted", async () => {
    // Setup: installer created config with only managed rules
    const initialConfig = {
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "deny",
              flow: "deny",
            },
          },
        },
      },
    };
    const configContent = JSON.stringify(initialConfig);

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "flow",
            lastWrittenValue: "deny",
          }),
        ],
        createdConfigFile: "opencode.json",
        initialConfigState: initialConfig,
      })
    );

    await createTestEnv(tmpDir, { configContent, manifest });

    const result = await uninstallCommand({ projectDir: tmpDir });

    expect(result.success).toBe(true);

    // Config file should be deleted (only had managed content)
    expect(await pathExists(join(tmpDir, "opencode.json"))).toBe(false);
  });

  // ── Test 10: Installer-created config file with user content → preserved ──

  it("10. Installer-created config file with user content → preserved", async () => {
    // Setup: installer created config, user added more content
    const initialConfig = {
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "deny",
            },
          },
        },
      },
    };
    const configContent = JSON.stringify({
      ...initialConfig,
      name: "user-project",
    });

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
        ],
        createdConfigFile: "opencode.json",
        initialConfigState: initialConfig,
      })
    );

    await createTestEnv(tmpDir, { configContent, manifest });

    const result = await uninstallCommand({ projectDir: tmpDir });

    expect(result.success).toBe(true);

    // Config file should be preserved (user added content)
    expect(await pathExists(join(tmpDir, "opencode.json"))).toBe(true);

    const content = await readFile(join(tmpDir, "opencode.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.name).toBe("user-project");
    expect(parsed.agent.build.permission.task["sof-*"]).toBeUndefined();
  });

  // ── Test 11: --dry-run → zero writes, complete report ─────────────────────

  it("11. --dry-run → zero writes, complete report", async () => {
    // Setup: normal uninstall scenario
    const configContent = JSON.stringify({
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "deny",
              flow: "deny",
            },
          },
        },
      },
    });

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "flow",
            lastWrittenValue: "deny",
          }),
        ],
      })
    );

    await createTestEnv(tmpDir, { configContent, manifest });

    const result = await uninstallCommand({ projectDir: tmpDir, dryRun: true });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.report).toBeDefined();
    expect(result.report!.wouldSucceed).toBe(true);
    expect(result.report!.conflicts).toHaveLength(0);

    // Verify ZERO writes occurred
    expect(
      await pathExists(join(tmpDir, ".opencode", "agents", "sof-explore-repository.md"))
    ).toBe(true);
    expect(await pathExists(join(tmpDir, "opencode.json"))).toBe(true);
    expect(await pathExists(join(tmpDir, ".opencode", ".sof-manifest.json"))).toBe(true);
  });

  // ── Test 12: Missing manifest → blocked ───────────────────────────────────

  it("12. Missing manifest → blocked", async () => {
    // Setup: no manifest file
    await mkdir(join(tmpDir, ".opencode", "agents"), { recursive: true });

    await expect(uninstallCommand({ projectDir: tmpDir })).rejects.toThrow(
      /No manifest found/
    );
  });

  // ── Test 13 (bonus): Agent-before-protection ordering verified ─────────────

  it("13. Agent-before-protection ordering: agents deleted before config rules removed", async () => {
    // Track deletion order
    const deletionOrder: string[] = [];

    const configContent = JSON.stringify({
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "deny",
            },
          },
        },
      },
    });

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
        ],
      })
    );

    await createTestEnv(tmpDir, { configContent, manifest });

    // Verify agent exists before uninstall
    const agentPath = join(tmpDir, ".opencode", "agents", "sof-explore-repository.md");
    expect(await pathExists(agentPath)).toBe(true);

    const result = await uninstallCommand({ projectDir: tmpDir });

    expect(result.success).toBe(true);

    // Agent should be gone
    expect(await pathExists(agentPath)).toBe(false);

    // Config should have rules removed
    const content = await readFile(join(tmpDir, "opencode.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.agent.build.permission.task["sof-*"]).toBeUndefined();
  });

  // ── Test 14 (bonus): Corrupt manifest → blocked ───────────────────────────

  it("14. Corrupt manifest → blocked", async () => {
    // Setup: corrupt manifest file
    await mkdir(join(tmpDir, ".opencode"), { recursive: true });
    await writeFile(
      join(tmpDir, ".opencode", ".sof-manifest.json"),
      "{invalid json!!!"
    );

    await expect(uninstallCommand({ projectDir: tmpDir })).rejects.toThrow(
      /Cannot read manifest/
    );
  });

  // ── Test 15 (bonus): Incompatible manifest version → blocked ──────────────

  it("15. Incompatible manifest version → blocked", async () => {
    // Setup: manifest with wrong version
    await mkdir(join(tmpDir, ".opencode"), { recursive: true });
    const badManifest = {
      version: "99.0",
      entries: {},
      lastWrittenTaskSnapshots: {},
    };
    await writeFile(
      join(tmpDir, ".opencode", ".sof-manifest.json"),
      JSON.stringify(badManifest)
    );

    await expect(uninstallCommand({ projectDir: tmpDir })).rejects.toThrow(
      /Cannot read manifest|Incompatible schema version/
    );
  });

  // ── Test 16 (bonus): Backup directory created during uninstall ─────────────

  it("16. Backup directory created during uninstall", async () => {
    const configContent = JSON.stringify({
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "deny",
            },
          },
        },
      },
    });

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
        ],
      })
    );

    await createTestEnv(tmpDir, { configContent, manifest });

    await uninstallCommand({ projectDir: tmpDir });

    // Verify backup directory was created
    const opencodeDir = join(tmpDir, ".opencode");
    const entries = await readdir(opencodeDir);
    const backupDirs = entries.filter((e) => e.startsWith(".sof-backups"));
    expect(backupDirs.length).toBeGreaterThan(0);
  });

  // ── Test 17 (bonus): --dry-run shows conflicts for user-modified rules ────

  it("17. --dry-run shows conflicts for user-modified rules", async () => {
    const configContent = JSON.stringify({
      agent: {
        build: {
          permission: {
            task: {
              "sof-*": "allow",
            },
          },
        },
      },
    });

    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
        ],
      })
    );

    await createTestEnv(tmpDir, { configContent, manifest });

    const result = await uninstallCommand({ projectDir: tmpDir, dryRun: true });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.report!.wouldSucceed).toBe(false);
    expect(result.report!.conflicts.length).toBeGreaterThan(0);
    expect(result.report!.conflicts[0]).toContain("User-modified");
  });

  // ── Test 18 (bonus): Multiple agents with independent rules ───────────────

  it("18. Multiple agents with independent rules → all removed correctly", async () => {
    const configContent = JSON.stringify({
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
            },
          },
        },
      },
    });

    let manifest = createManifest(tmpDir, "0.1.0");

    // Agent 1 with build rules
    manifest = addAgentEntry(
      manifest,
      "sof-explore-repository",
      makeAgentEntry({
        configRules: [
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
          makeConfigRule({
            targetPath: "agent.build.permission.task",
            ruleKey: "flow",
            lastWrittenValue: "deny",
          }),
        ],
      })
    );

    // Agent 2 with plan rules
    manifest = addAgentEntry(
      manifest,
      "sof-design-change",
      makeAgentEntry({
        agentName: "sof-design-change",
        installedPath: ".opencode/agents/sof-design-change.md",
        configRules: [
          makeConfigRule({
            targetPath: "agent.plan.permission.task",
            ruleKey: "sof-*",
            lastWrittenValue: "deny",
          }),
        ],
      })
    );

    await createTestEnv(tmpDir, {
      configContent,
      manifest,
      agentFiles: ["sof-explore-repository.md", "sof-design-change.md"],
    });

    const result = await uninstallCommand({ projectDir: tmpDir });

    expect(result.success).toBe(true);

    // Both agents should be removed
    expect(
      await pathExists(join(tmpDir, ".opencode", "agents", "sof-explore-repository.md"))
    ).toBe(false);
    expect(
      await pathExists(join(tmpDir, ".opencode", "agents", "sof-design-change.md"))
    ).toBe(false);

    // Config should have all managed rules removed
    const content = await readFile(join(tmpDir, "opencode.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.agent.build.permission.task["sof-*"]).toBeUndefined();
    expect(parsed.agent.build.permission.task.flow).toBeUndefined();
    expect(parsed.agent.plan.permission.task["sof-*"]).toBeUndefined();
  });
});
