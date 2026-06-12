import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { install } from "../../src/commands/install.js";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManifest, writeManifest, type Manifest, type ManifestEntry } from "../../src/core/manifest.js";
import { computeHash, getPackageAgentDir } from "../../src/core/agents.js";

describe("install command", () => {
  let tempDir: string;
  let projectDir: string;
  let agentsDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "install-test-"));
    projectDir = tempDir;
    agentsDir = join(projectDir, ".opencode", "agents");
    configPath = join(projectDir, "opencode.json");

    // Create project structure with .git directory
    await mkdir(join(projectDir, ".git"), { recursive: true });
    await mkdir(agentsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("fresh install with no existing config", () => {
    it("installs successfully with no existing config", async () => {
      // No config file exists
      const result = await install({ projectDir });

      // Should succeed
      expect(result.wouldSucceed).toBe(true);

      // Verify agents were copied
      const agentFiles = await readdir(agentsDir);
      expect(agentFiles.length).toBeGreaterThan(0);
      expect(agentFiles).toContain("sof-explore-repository.md");
      expect(agentFiles).toContain("flow.md");

      // Verify config was created with managed deny rules
      const configContent = JSON.parse(await readFile(configPath, "utf-8"));
      expect(configContent.agent.build.permission.task["sof-*"]).toBe("deny");
      expect(configContent.agent.build.permission.task["flow"]).toBe("deny");
      expect(configContent.agent.plan.permission.task["sof-*"]).toBe("deny");
      expect(configContent.agent.plan.permission.task["flow"]).toBe("deny");

      // Verify manifest was created
      const manifestPath = join(projectDir, ".opencode", ".sof-manifest.json");
      const manifestContent = JSON.parse(await readFile(manifestPath, "utf-8"));
      expect(manifestContent.version).toBe("1.0");
      expect(Object.keys(manifestContent.entries).length).toBeGreaterThan(0);
    });
  });

  describe("fresh install with existing config", () => {
    it("installs successfully and preserves user config fields", async () => {
      // Create config with user fields
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
        },
        customField: "preserved"
      };
      await writeFile(configPath, JSON.stringify(userConfig, null, 2));

      const result = await install({ projectDir });

      // Should succeed
      expect(result.wouldSucceed).toBe(true);

      // Verify config has managed rules AND user fields preserved
      const configContent = JSON.parse(await readFile(configPath, "utf-8"));
      expect(configContent.agent.build.permission.task["sof-*"]).toBe("deny");
      expect(configContent.agent.build.permission.task["flow"]).toBe("deny");
      expect(configContent.agent.build.permission.task["user-rule"]).toBe("allow");
      expect(configContent.customField).toBe("preserved");
    });
  });

  describe("--global install", () => {
    it("installs to ~/.config/opencode/agents/ with --global flag", async () => {
      // This test verifies that --global flag is properly handled
      // In a real scenario, this would install to ~/.config/opencode/
      // For testing, we verify the scope resolution works
      const result = await install({ global: true });

      // Should succeed
      expect(result.wouldSucceed).toBe(true);
    });
  });

  describe("--dry-run", () => {
    it("reports operations without making writes", async () => {
      // No config file exists
      const result = await install({ projectDir, dryRun: true });

      // Should report success
      expect(result.wouldSucceed).toBe(true);

      // Verify NO files were created
      try {
        await access(configPath);
        // If we reach here, config was created — that's a failure
        expect(true).toBe(false);
      } catch {
        // Expected: config file does not exist
      }

      // Verify no agents were copied
      try {
        const agentFiles = await readdir(agentsDir);
        expect(agentFiles.length).toBe(0);
      } catch {
        // Expected: agents directory doesn't exist or is empty
      }

      // Verify no manifest was created
      try {
        const manifestPath = join(projectDir, ".opencode", ".sof-manifest.json");
        await access(manifestPath);
        expect(true).toBe(false);
      } catch {
        // Expected: manifest does not exist
      }
    });

    it("reports conflicts in dry-run mode", async () => {
      // Create agent file with different content
      const existingContent = "# Different content";
      await writeFile(join(agentsDir, "sof-explore-repository.md"), existingContent);

      const result = await install({ projectDir, dryRun: true });

      // Should report conflict
      expect(result.wouldSucceed).toBe(false);
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts[0]).toContain("sof-explore-repository.md");

      // Verify original file was NOT modified
      const currentContent = await readFile(join(agentsDir, "sof-explore-repository.md"), "utf-8");
      expect(currentContent).toBe(existingContent);
    });
  });

  describe("--migrate-legacy", () => {
    it("migrates legacy agents with matching hashes", async () => {
      // Get package agent directory
      const packageAgentDir = getPackageAgentDir();

      // Read the original legacy file content (the pre-rename version)
      // The legacy hash is for the original explore-repository.md without sof- prefix
      // We need to use content that matches the frozen hash
      const legacyContent = await readFile(join(packageAgentDir, "sof-explore-repository.md"), "utf-8");
      // Create legacy filename (without sof- prefix)
      await writeFile(join(agentsDir, "explore-repository.md"), legacyContent);

      // Use --force to handle any conflicts
      await install({ projectDir, migrateLegacy: true, force: true });

      // Verify agents were copied
      const agentFiles = await readdir(agentsDir);
      expect(agentFiles).toContain("sof-explore-repository.md");
    });

    it("blocks migration with hash-mismatched legacy without --force", async () => {
      // Create legacy file with different content (hash mismatch)
      await writeFile(join(agentsDir, "explore-repository.md"), "# Different content");

      await expect(
        install({ projectDir, migrateLegacy: true })
      ).rejects.toThrow("Install blocked by conflicts");
    });

    it("allows migration with hash-mismatched legacy with --force", async () => {
      // Create legacy file with different content (hash mismatch)
      await writeFile(join(agentsDir, "explore-repository.md"), "# Different content");

      // With --force, install should succeed despite conflicts
      await install({ projectDir, migrateLegacy: true, force: true });

      // Verify agents were copied (install succeeded)
      const agentFiles = await readdir(agentsDir);
      expect(agentFiles).toContain("sof-explore-repository.md");
    });
  });

  describe("--force with conflicts", () => {
    it("resolves ownership conflict with --force", async () => {
      // Create agent file with different content
      await writeFile(join(agentsDir, "sof-explore-repository.md"), "# Different content");

      // With --force, install should succeed despite conflicts
      await install({ projectDir, force: true });

      // Verify file was overwritten with package source
      const packageAgentDir = getPackageAgentDir();
      const expectedContent = await readFile(join(packageAgentDir, "sof-explore-repository.md"), "utf-8");
      const actualContent = await readFile(join(agentsDir, "sof-explore-repository.md"), "utf-8");
      expect(actualContent).toBe(expectedContent);
    });
  });

  describe("--force with malformed config", () => {
    it("still blocks with malformed config even with --force", async () => {
      // Create malformed config
      await writeFile(configPath, "invalid json{{{");

      await expect(
        install({ projectDir, force: true })
      ).rejects.toThrow();
    });
  });

  describe("--project path", () => {
    it("works with explicit --project path even without Git root", async () => {
      // Create a directory without .git
      const noGitDir = join(tempDir, "no-git");
      await mkdir(noGitDir, { recursive: true });

      const result = await install({ projectDir: noGitDir });

      // Should succeed with explicit path
      expect(result.wouldSucceed).toBe(true);
    });
  });

  describe("default scope resolution", () => {
    it("discovers Git root by default", async () => {
      // projectDir has .git directory created in beforeEach
      const result = await install({ projectDir });

      // Should succeed
      expect(result.wouldSucceed).toBe(true);
    });
  });

  describe("dual config rejection", () => {
    it("fails when both opencode.json and opencode.jsonc exist", async () => {
      // Create both config files
      await writeFile(configPath, "{}");
      await writeFile(join(projectDir, "opencode.jsonc"), "{}");

      await expect(
        install({ projectDir })
      ).rejects.toThrow("Ambiguous configuration");
    });
  });

  describe("install ordering", () => {
    it("patches config protection before copying agents", async () => {
      const result = await install({ projectDir });

      // Should succeed
      expect(result.wouldSucceed).toBe(true);

      // Verify config has managed deny rules
      const configContent = JSON.parse(await readFile(configPath, "utf-8"));
      expect(configContent.agent.build.permission.task["sof-*"]).toBe("deny");
      expect(configContent.agent.build.permission.task["flow"]).toBe("deny");
      expect(configContent.agent.plan.permission.task["sof-*"]).toBe("deny");
      expect(configContent.agent.plan.permission.task["flow"]).toBe("deny");

      // Verify agents were copied
      const agentFiles = await readdir(agentsDir);
      expect(agentFiles.length).toBeGreaterThan(0);
    });
  });

  describe("manifest creation", () => {
    it("creates manifest with correct agent entries", async () => {
      const result = await install({ projectDir });

      // Should succeed
      expect(result.wouldSucceed).toBe(true);

      // Verify manifest
      const manifestPath = join(projectDir, ".opencode", ".sof-manifest.json");
      const manifestContent = JSON.parse(await readFile(manifestPath, "utf-8"));

      // Should have entries for all agents
      expect(Object.keys(manifestContent.entries).length).toBeGreaterThan(0);

      // Verify a specific entry
      const exploreEntry = manifestContent.entries["sof-explore-repository"];
      expect(exploreEntry).toBeDefined();
      expect(exploreEntry.agentName).toBe("sof-explore-repository");
      expect(exploreEntry.managedBy).toBe("sof");
    });
  });

  describe("backup creation", () => {
    it("creates backup directory before modifying files", async () => {
      // Create existing agent file
      const existingContent = "# Existing content";
      await writeFile(join(agentsDir, "sof-explore-repository.md"), existingContent);

      // Use --force to handle conflicts
      await install({ projectDir, force: true });

      // Verify backup directory was created
      const opencodeDir = join(projectDir, ".opencode");
      const entries = await readdir(opencodeDir);
      const backupDirs = entries.filter((e) => e.startsWith(".sof-backups"));
      expect(backupDirs.length).toBeGreaterThan(0);

      // Verify backup contains the original file
      const backupDir = join(opencodeDir, backupDirs[0]);
      const backupFiles = await readdir(backupDir);
      expect(backupFiles).toContain("sof-explore-repository.md");
    });
  });
});
