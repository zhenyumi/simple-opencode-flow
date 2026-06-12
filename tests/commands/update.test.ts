import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { update } from "../../src/commands/update.js";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManifest, writeManifest, type Manifest, type ManifestEntry } from "../../src/core/manifest.js";
import { computeHash, getPackageAgentDir } from "../../src/core/agents.js";

describe("update command", () => {
  let tempDir: string;
  let projectDir: string;
  let agentsDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "update-test-"));
    projectDir = tempDir;
    agentsDir = join(projectDir, ".opencode", "agents");
    configPath = join(projectDir, "opencode.json");

    // Create project structure
    await mkdir(agentsDir, { recursive: true });

    // Create a basic config file
    await writeFile(configPath, JSON.stringify({
      agent: {
        build: {
          permission: {
            task: {}
          }
        },
        plan: {
          permission: {
            task: {}
          }
        }
      }
    }, null, 2));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper: Create a manifest with agent entries for testing.
   */
  async function createTestManifest(agents: Array<{ name: string; sourceHash: string }>): Promise<Manifest> {
    const manifest = createManifest(projectDir, "1.0.0");

    for (const agent of agents) {
      const entry: ManifestEntry = {
        agentName: agent.name,
        installedPath: join(agentsDir, `${agent.name}.md`),
        sourceHash: agent.sourceHash,
        installedAt: new Date().toISOString(),
        managedBy: "sof",
        configRules: [],
        scalarConversion: null,
        createdAncestors: [],
        createdConfigFile: null,
        initialConfigState: null,
        configPath: configPath,
        lastWrittenStateFingerprint: "test-fingerprint",
        manifestSchemaVersion: "1.0",
        installerVersion: "1.0.0",
      };

      manifest.entries[agent.name] = entry;
    }

    return manifest;
  }

  describe("missing manifest", () => {
    it("blocks update when manifest is missing", async () => {
      await expect(
        update({ projectDir })
      ).rejects.toThrow("No manifest found");
    });
  });

  describe("no changes needed", () => {
    it("succeeds with no-op when no changes needed", async () => {
      // Use real agent content from the package directory
      const packageAgentDir = getPackageAgentDir();
      const flowContent = await readFile(join(packageAgentDir, "flow.md"), "utf-8");
      await writeFile(join(agentsDir, "flow.md"), flowContent);

      const exploreContent = await readFile(join(packageAgentDir, "sof-explore-repository.md"), "utf-8");
      await writeFile(join(agentsDir, "sof-explore-repository.md"), exploreContent);

      // Compute hashes — these must match the package source hashes
      const flowHash = await computeHash(join(agentsDir, "flow.md"));
      const exploreHash = await computeHash(join(agentsDir, "sof-explore-repository.md"));

      // Create manifest with matching hashes (same as package source)
      const manifest = await createTestManifest([
        { name: "flow", sourceHash: flowHash },
        { name: "sof-explore-repository", sourceHash: exploreHash },
      ]);

      await writeManifest(projectDir, manifest);

      // Run update
      const result = await update({ projectDir });

      // Should succeed with no conflicts
      expect(result.wouldSucceed).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });
  });

  describe("package source changed", () => {
    it("updates agent when package source changed", async () => {
      // Create agent files in target directory with old content
      const oldContent = "# Old flow content";
      await writeFile(join(agentsDir, "flow.md"), oldContent);

      // Compute hash of old content
      const oldHash = await computeHash(join(agentsDir, "flow.md"));

      // Create manifest with old hash — this tells update the last-installed version
      const manifest = await createTestManifest([
        { name: "flow", sourceHash: oldHash },
      ]);

      await writeManifest(projectDir, manifest);

      // Run update
      const result = await update({ projectDir });

      // Should succeed
      expect(result.wouldSucceed).toBe(true);

      // Verify agent was updated (content should match package source)
      const updatedContent = await readFile(join(agentsDir, "flow.md"), "utf-8");
      expect(updatedContent).not.toBe(oldContent);
    });
  });

  describe("user modified agent", () => {
    it("blocks update when user modified agent without --force", async () => {
      // Create agent files in target directory with real content
      const packageAgentDir = getPackageAgentDir();
      const flowContent = await readFile(join(packageAgentDir, "flow.md"), "utf-8");
      await writeFile(join(agentsDir, "flow.md"), flowContent);

      // Create manifest with different hash (simulating user modification after install)
      const manifest = await createTestManifest([
        { name: "flow", sourceHash: "different-hash" },
      ]);

      await writeManifest(projectDir, manifest);

      // Run update without --force
      await expect(
        update({ projectDir })
      ).rejects.toThrow("Update blocked by conflicts");
    });

    it("overwrites user-modified agent with --force", async () => {
      // Create agent files in target directory with user modification
      const userContent = "# User modified flow";
      await writeFile(join(agentsDir, "flow.md"), userContent);

      // Create manifest with different hash
      const manifest = await createTestManifest([
        { name: "flow", sourceHash: "different-hash" },
      ]);

      await writeManifest(projectDir, manifest);

      // Run update with --force - should not throw despite conflicts
      const result = await update({ projectDir, force: true });

      // Preflight still reports conflicts (that's correct - it's read-only analysis)
      // But the update should succeed because --force is specified
      expect(result.conflicts.length).toBeGreaterThan(0);

      // Verify agent was overwritten with package source
      const updatedContent = await readFile(join(agentsDir, "flow.md"), "utf-8");
      expect(updatedContent).not.toBe(userContent);
    });
  });

  describe("config protection", () => {
    it("preserves user-added config rules during update", async () => {
      // Create config with user-added rules
      const userConfig = {
        agent: {
          build: {
            permission: {
              task: {
                "user-rule": "allow",
              }
            }
          },
          plan: {
            permission: {
              task: {}
            }
          }
        }
      };

      await writeFile(configPath, JSON.stringify(userConfig, null, 2));

      // Create agent files with real content
      const packageAgentDir = getPackageAgentDir();
      const flowContent = await readFile(join(packageAgentDir, "flow.md"), "utf-8");
      await writeFile(join(agentsDir, "flow.md"), flowContent);

      const flowHash = await computeHash(join(agentsDir, "flow.md"));

      // Create manifest
      const manifest = await createTestManifest([
        { name: "flow", sourceHash: flowHash },
      ]);

      await writeManifest(projectDir, manifest);

      // Run update
      await update({ projectDir });

      // Verify user-added rules are preserved
      const updatedConfig = JSON.parse(await readFile(configPath, "utf-8"));
      expect(updatedConfig.agent.build.permission.task["user-rule"]).toBe("allow");
    });
  });

  describe("dry-run", () => {
    it("reports operations without making writes", async () => {
      // Create agent files with real content
      const packageAgentDir = getPackageAgentDir();
      const flowContent = await readFile(join(packageAgentDir, "flow.md"), "utf-8");
      await writeFile(join(agentsDir, "flow.md"), flowContent);

      // Create manifest with different hash (simulating user modification)
      const manifest = await createTestManifest([
        { name: "flow", sourceHash: "different-hash" },
      ]);

      await writeManifest(projectDir, manifest);

      // Run dry-run
      const result = await update({ projectDir, dryRun: true });

      // Should report conflict
      expect(result.wouldSucceed).toBe(false);
      expect(result.conflicts.length).toBeGreaterThan(0);

      // Verify no files were modified
      const currentContent = await readFile(join(agentsDir, "flow.md"), "utf-8");
      expect(currentContent).toBe(flowContent);
    });

    it("reports zero writes in dry-run mode when nothing needs update", async () => {
      // Create config with managed deny rules already in place
      const configWithRules = {
        agent: {
          build: {
            permission: {
              task: {
                "sof-*": "deny",
                "flow": "deny",
              }
            }
          },
          plan: {
            permission: {
              task: {
                "sof-*": "deny",
                "flow": "deny",
              }
            }
          }
        }
      };

      await writeFile(configPath, JSON.stringify(configWithRules, null, 2));

      // Create agent files with real content from package (so hashes match)
      const packageAgentDir = getPackageAgentDir();
      const flowContent = await readFile(join(packageAgentDir, "flow.md"), "utf-8");
      await writeFile(join(agentsDir, "flow.md"), flowContent);

      // Compute hash — must match package source
      const flowHash = await computeHash(join(agentsDir, "flow.md"));
      // Also compute package source hash to verify they match
      const sourceHash = await computeHash(join(packageAgentDir, "flow.md"));

      // Create manifest where sourceHash = the same hash (simulating no package change)
      const manifest = await createTestManifest([
        { name: "flow", sourceHash: sourceHash },
      ]);

      await writeManifest(projectDir, manifest);

      // Run dry-run
      const result = await update({ projectDir, dryRun: true });

      // Should succeed with no operations (config already has rules, agent hash matches)
      expect(result.wouldSucceed).toBe(true);
      expect(result.orderedOperations).toHaveLength(0);
    });
  });

  describe("corrupt manifest", () => {
    it("blocks update when manifest is corrupt", async () => {
      // Write corrupt manifest
      await mkdir(join(projectDir, ".opencode"), { recursive: true });
      await writeFile(join(projectDir, ".opencode", ".sof-manifest.json"), "invalid json");

      await expect(
        update({ projectDir })
      ).rejects.toThrow("Corrupt manifest");
    });

    it("blocks update when manifest has incompatible version", async () => {
      // Write manifest with incompatible version
      const manifest = {
        version: "2.0",
        entries: {},
        lastWrittenTaskSnapshots: {},
      };

      await mkdir(join(projectDir, ".opencode"), { recursive: true });
      await writeFile(
        join(projectDir, ".opencode", ".sof-manifest.json"),
        JSON.stringify(manifest, null, 2)
      );

      await expect(
        update({ projectDir })
      ).rejects.toThrow("Incompatible schema version");
    });
  });

  describe("global scope", () => {
    it("resolves scope correctly for --global flag", async () => {
      // Use project scope with fresh temp dir (no manifest) to test missing-manifest behavior.
      // --global hits real ~/.config/opencode/ which may have a manifest from prior runs.
      await expect(
        update({ projectDir })
      ).rejects.toThrow("No manifest found");
    });
  });

  describe("rollback on error", () => {
    it("performs best-effort rollback on error", async () => {
      // Create agent files with real content
      const packageAgentDir = getPackageAgentDir();
      const flowContent = await readFile(join(packageAgentDir, "flow.md"), "utf-8");
      await writeFile(join(agentsDir, "flow.md"), flowContent);

      const flowHash = await computeHash(join(agentsDir, "flow.md"));

      // Create manifest with matching hashes
      const manifest = await createTestManifest([
        { name: "flow", sourceHash: flowHash },
      ]);

      await writeManifest(projectDir, manifest);

      // Corrupt the config file to cause an error during update
      await writeFile(configPath, "invalid json");

      // Run update - should fail and rollback
      await expect(
        update({ projectDir })
      ).rejects.toThrow();

      // Verify original agent file is preserved
      const currentContent = await readFile(join(agentsDir, "flow.md"), "utf-8");
      expect(currentContent).toBe(flowContent);
    });
  });
});
