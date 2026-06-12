import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readManifest,
  createManifest,
  addAgentEntry,
  addConfigRuleEntry,
  removeAgentEntry,
  getLastWrittenTaskSnapshot,
  compareTaskSnapshot,
  isManaged,
  isConfigRuleManaged,
  validateManifest,
  writeManifest,
  computeConfigFingerprint,
  MANIFEST_SCHEMA_VERSION,
  type Manifest,
  type ManifestEntry,
  type ConfigRuleEntry,
  type TaskPolicySnapshot,
} from "../../src/core/manifest.js";
import { mkdtemp, writeFile, rm, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function makeConfigRule(overrides: Partial<ConfigRuleEntry> = {}): ConfigRuleEntry {
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("manifest", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "manifest-test-"));
    // Create .opencode directory structure
    await mkdir(join(tmpDir, ".opencode"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Test 1: Create manifest → valid ──────────────────────────────────────

  it("1. createManifest produces a valid manifest", () => {
    const manifest = createManifest(tmpDir, "0.1.0");

    expect(manifest.version).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.entries).toEqual({});
    expect(manifest.lastWrittenTaskSnapshots).toEqual({});

    const validation = validateManifest(manifest);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  // ── Test 2: Add agent entry → entry present ─────────────────────────────

  it("2. addAgentEntry makes entry retrievable", () => {
    const manifest = createManifest(tmpDir, "0.1.0");
    const entry = makeAgentEntry({ agentName: "sof-design-change" });

    const updated = addAgentEntry(manifest, "sof-design-change", entry);

    expect(updated.entries["sof-design-change"]).toEqual(entry);
    expect(isManaged(updated, "sof-design-change")).toBe(true);
  });

  // ── Test 3: Add config rule entry → rule tracked with pre-existing status ─

  it("3. addConfigRuleEntry tracks rule with pre-existing status", () => {
    let manifest = createManifest(tmpDir, "0.1.0");
    const entry = makeAgentEntry();
    manifest = addAgentEntry(manifest, "sof-explore-repository", entry);

    const rule = makeConfigRule({
      existedBefore: true,
      previousValue: "allow",
      previousOrderedPosition: 0,
      action: "changed",
    });

    manifest = addConfigRuleEntry(manifest, "sof-explore-repository", rule);

    const storedEntry = manifest.entries["sof-explore-repository"];
    expect(storedEntry.configRules).toHaveLength(1);
    expect(storedEntry.configRules[0].existedBefore).toBe(true);
    expect(storedEntry.configRules[0].previousValue).toBe("allow");
    expect(storedEntry.configRules[0].action).toBe("changed");
  });

  // ── Test 4: Remove agent entry → entry absent ───────────────────────────

  it("4. removeAgentEntry removes the entry", () => {
    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(manifest, "sof-review-plan", makeAgentEntry({ agentName: "sof-review-plan" }));

    expect(isManaged(manifest, "sof-review-plan")).toBe(true);

    manifest = removeAgentEntry(manifest, "sof-review-plan");

    expect(isManaged(manifest, "sof-review-plan")).toBe(false);
    expect(manifest.entries["sof-review-plan"]).toBeUndefined();
  });

  // ── Test 5: Corrupt manifest (invalid JSON) → read throws ────────────────

  it("5. readManifest throws on corrupt (invalid JSON) manifest", async () => {
    await writeFile(join(tmpDir, ".opencode", ".sof-manifest.json"), "{invalid json!!!");

    await expect(readManifest(tmpDir)).rejects.toThrow(/invalid JSON/i);
  });

  // ── Test 6: Incompatible schema version → read throws ────────────────────

  it("6. readManifest throws on incompatible schema version", async () => {
    const badManifest = {
      version: "99.0",
      entries: {},
      lastWrittenTaskSnapshots: {},
    };
    await writeFile(
      join(tmpDir, ".opencode", ".sof-manifest.json"),
      JSON.stringify(badManifest)
    );

    await expect(readManifest(tmpDir)).rejects.toThrow(/Incompatible schema version/i);
  });

  // ── Test 7: Missing manifest → read returns null ─────────────────────────

  it("7. readManifest returns null when file is missing", async () => {
    const result = await readManifest(tmpDir);
    expect(result).toBeNull();
  });

  // ── Test 8: Semantic comparison: identical Task snapshots → identical=true ─

  it("8. compareTaskSnapshot returns identical=true for matching snapshots", () => {
    let manifest = createManifest(tmpDir, "0.1.0");
    const snapshot: TaskPolicySnapshot = [
      ["*", "allow"],
      ["sof-*", "deny"],
      ["flow", "deny"],
    ];
    manifest = {
      ...manifest,
      lastWrittenTaskSnapshots: {
        "agent.build.permission.task": snapshot,
      },
    };

    const result = compareTaskSnapshot(manifest, "agent.build.permission.task", [
      ["*", "allow"],
      ["sof-*", "deny"],
      ["flow", "deny"],
    ]);

    expect(result.identical).toBe(true);
    expect(result.differences).toHaveLength(0);
  });

  // ── Test 9: Semantic comparison: different ordering → differences detected ─

  it("9. compareTaskSnapshot detects different ordering", () => {
    let manifest = createManifest(tmpDir, "0.1.0");
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

    const result = compareTaskSnapshot(manifest, "agent.build.permission.task", [
      ["*", "allow"],
      ["flow", "deny"],
      ["sof-*", "deny"],
    ]);

    expect(result.identical).toBe(false);
    expect(result.differences.length).toBeGreaterThan(0);
    expect(result.differences.some((d) => d.includes("position 1"))).toBe(true);
  });

  // ── Test 10: Semantic comparison: different values → differences detected ──

  it("10. compareTaskSnapshot detects different values", () => {
    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = {
      ...manifest,
      lastWrittenTaskSnapshots: {
        "agent.build.permission.task": [
          ["sof-*", "deny"],
          ["flow", "deny"],
        ],
      },
    };

    const result = compareTaskSnapshot(manifest, "agent.build.permission.task", [
      ["sof-*", "allow"],
      ["flow", "deny"],
    ]);

    expect(result.identical).toBe(false);
    expect(result.differences[0]).toContain('["sof-*", "deny"]');
    expect(result.differences[0]).toContain('["sof-*", "allow"]');
  });

  // ── Test 11: Scalar-to-object conversion tracking ─────────────────────────

  it("11. scalarConversion records original value, never as inline key", () => {
    let manifest = createManifest(tmpDir, "0.1.0");
    const entry = makeAgentEntry({
      scalarConversion: { originalValue: "allow" },
    });
    manifest = addAgentEntry(manifest, "sof-explore-repository", entry);

    const stored = manifest.entries["sof-explore-repository"];
    expect(stored.scalarConversion).not.toBeNull();
    expect(stored.scalarConversion!.originalValue).toBe("allow");

    // Verify no inline config key for the original value
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("_sof_scalar_original");
  });

  // ── Test 12: Installer-created ancestors tracking ─────────────────────────

  it("12. createdAncestors records installer-created ancestor directories", () => {
    let manifest = createManifest(tmpDir, "0.1.0");
    const entry = makeAgentEntry({
      createdAncestors: [".opencode", ".opencode/agents"],
    });
    manifest = addAgentEntry(manifest, "sof-explore-repository", entry);

    const stored = manifest.entries["sof-explore-repository"];
    expect(stored.createdAncestors).toEqual([".opencode", ".opencode/agents"]);
  });

  // ── Test 13: Installer-created config file tracking ───────────────────────

  it("13. createdConfigFile records installer-created config file path", () => {
    let manifest = createManifest(tmpDir, "0.1.0");
    const entry = makeAgentEntry({
      createdConfigFile: "opencode.json",
      initialConfigState: {},
    });
    manifest = addAgentEntry(manifest, "sof-explore-repository", entry);

    const stored = manifest.entries["sof-explore-repository"];
    expect(stored.createdConfigFile).toBe("opencode.json");
    expect(stored.initialConfigState).toEqual({});
  });

  // ── Test 14: Config fingerprint computation → deterministic ───────────────

  it("14. computeConfigFingerprint produces deterministic SHA-256", async () => {
    const configContent = JSON.stringify({
      agent: { build: { permission: { task: { "sof-*": "deny" } } } },
    });
    const configPath = join(tmpDir, "opencode.json");
    await writeFile(configPath, configContent);

    const expectedHash = createHash("sha256").update(configContent).digest("hex");

    const fp1 = await computeConfigFingerprint(configPath, [
      "agent.build.permission.task",
    ]);
    const fp2 = await computeConfigFingerprint(configPath, [
      "agent.build.permission.task",
    ]);

    expect(fp1).toBe(expectedHash);
    expect(fp2).toBe(expectedHash);
    expect(fp1).toBe(fp2);
  });

  // ── Test 15: isManaged returns false for user-owned pre-existing rules ────

  it("15. isManaged returns false for agents not in manifest (user-owned)", () => {
    const manifest = createManifest(tmpDir, "0.1.0");

    expect(isManaged(manifest, "user-custom-agent")).toBe(false);
    expect(isManaged(manifest, "sof-explore-repository")).toBe(false);
  });

  // ── Test 16: Config rule entry with reorder tracking ──────────────────────

  it("16. addConfigRuleEntry records reorder tracking with positions", () => {
    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(manifest, "sof-explore-repository", makeAgentEntry());

    const rule = makeConfigRule({
      action: "reordered",
      reordered: true,
      originalPosition: 0,
      newPosition: 2,
      lastWrittenOrderedPosition: 2,
    });

    manifest = addConfigRuleEntry(manifest, "sof-explore-repository", rule);

    const stored = manifest.entries["sof-explore-repository"].configRules[0];
    expect(stored.reordered).toBe(true);
    expect(stored.originalPosition).toBe(0);
    expect(stored.newPosition).toBe(2);
    expect(stored.action).toBe("reordered");
  });

  // ── Test 17 (bonus): isConfigRuleManaged composite key identification ─────

  it("17. isConfigRuleManaged identifies rules by composite key (targetPath + ruleKey)", () => {
    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(manifest, "sof-explore-repository", makeAgentEntry());

    const buildSofRule = makeConfigRule({
      targetPath: "agent.build.permission.task",
      ruleKey: "sof-*",
    });
    const planFlowRule = makeConfigRule({
      targetPath: "agent.plan.permission.task",
      ruleKey: "flow",
    });

    manifest = addConfigRuleEntry(manifest, "sof-explore-repository", buildSofRule);
    manifest = addConfigRuleEntry(manifest, "sof-explore-repository", planFlowRule);

    // Both should be managed
    expect(isConfigRuleManaged(manifest, "agent.build.permission.task", "sof-*")).toBe(true);
    expect(isConfigRuleManaged(manifest, "agent.plan.permission.task", "flow")).toBe(true);

    // Different ruleKey at same path should NOT be managed
    expect(isConfigRuleManaged(manifest, "agent.build.permission.task", "flow")).toBe(false);
    // Different path with same key should NOT be managed
    expect(isConfigRuleManaged(manifest, "agent.other.permission.task", "sof-*")).toBe(false);
  });

  // ── Test 18 (bonus): addConfigRuleEntry replaces existing rule by composite key ─

  it("18. addConfigRuleEntry replaces existing rule with same composite key", () => {
    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(manifest, "sof-explore-repository", makeAgentEntry());

    const rule1 = makeConfigRule({ ruleValue: "deny", action: "inserted" });
    manifest = addConfigRuleEntry(manifest, "sof-explore-repository", rule1);

    const rule2 = makeConfigRule({ ruleValue: "warn", action: "changed" });
    manifest = addConfigRuleEntry(manifest, "sof-explore-repository", rule2);

    const rules = manifest.entries["sof-explore-repository"].configRules;
    expect(rules).toHaveLength(1);
    expect(rules[0].ruleValue).toBe("warn");
    expect(rules[0].action).toBe("changed");
  });

  // ── Test 19 (bonus): addConfigRuleEntry throws if agent entry missing ─────

  it("19. addConfigRuleEntry throws when agent entry not found", () => {
    const manifest = createManifest(tmpDir, "0.1.0");

    expect(() =>
      addConfigRuleEntry(manifest, "nonexistent-agent", makeConfigRule())
    ).toThrow(/Agent entry not found/);
  });

  // ── Test 20 (bonus): writeManifest and readManifest round-trip ────────────

  it("20. writeManifest and readManifest round-trip preserves data", async () => {
    let manifest = createManifest(tmpDir, "0.1.0");
    manifest = addAgentEntry(manifest, "sof-explore-repository", makeAgentEntry());
    manifest = addConfigRuleEntry(
      manifest,
      "sof-explore-repository",
      makeConfigRule()
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

    await writeManifest(tmpDir, manifest);
    const readBack = await readManifest(tmpDir);

    expect(readBack).not.toBeNull();
    expect(readBack!.version).toBe(MANIFEST_SCHEMA_VERSION);
    expect(readBack!.entries["sof-explore-repository"]).toBeDefined();
    expect(readBack!.entries["sof-explore-repository"].configRules).toHaveLength(1);
    expect(
      readBack!.lastWrittenTaskSnapshots["agent.build.permission.task"]
    ).toEqual([
      ["sof-*", "deny"],
      ["flow", "deny"],
    ]);
  });

  // ── Test 21 (bonus): compareTaskSnapshot with no last-written snapshot ────

  it("21. compareTaskSnapshot reports differences when no last-written snapshot exists", () => {
    const manifest = createManifest(tmpDir, "0.1.0");

    const result = compareTaskSnapshot(manifest, "agent.build.permission.task", [
      ["sof-*", "deny"],
    ]);

    expect(result.identical).toBe(false);
    expect(result.differences[0]).toContain("No last-written snapshot found");
  });

  // ── Test 22 (bonus): validateManifest rejects non-object input ────────────

  it("22. validateManifest rejects null and non-object inputs", () => {
    expect(validateManifest(null).valid).toBe(false);
    expect(validateManifest(undefined).valid).toBe(false);
    expect(validateManifest("string").valid).toBe(false);
    expect(validateManifest(42).valid).toBe(false);

    const result = validateManifest(null);
    expect(result.errors[0]).toContain("non-null object");
  });

  // ── Test 23 (bonus): multiple agents with multiple config rules ───────────

  it("23. multiple agents can each have independent config rules", () => {
    let manifest = createManifest(tmpDir, "0.1.0");

    manifest = addAgentEntry(manifest, "sof-explore-repository", makeAgentEntry());
    manifest = addAgentEntry(
      manifest,
      "sof-design-change",
      makeAgentEntry({ agentName: "sof-design-change" })
    );

    const buildSof = makeConfigRule({
      targetPath: "agent.build.permission.task",
      ruleKey: "sof-*",
    });
    const buildFlow = makeConfigRule({
      targetPath: "agent.build.permission.task",
      ruleKey: "flow",
    });
    const planSof = makeConfigRule({
      targetPath: "agent.plan.permission.task",
      ruleKey: "sof-*",
    });

    manifest = addConfigRuleEntry(manifest, "sof-explore-repository", buildSof);
    manifest = addConfigRuleEntry(manifest, "sof-explore-repository", buildFlow);
    manifest = addConfigRuleEntry(manifest, "sof-design-change", planSof);

    expect(
      isConfigRuleManaged(manifest, "agent.build.permission.task", "sof-*")
    ).toBe(true);
    expect(
      isConfigRuleManaged(manifest, "agent.build.permission.task", "flow")
    ).toBe(true);
    expect(
      isConfigRuleManaged(manifest, "agent.plan.permission.task", "sof-*")
    ).toBe(true);

    // Removing one agent should not affect the other's rules
    manifest = removeAgentEntry(manifest, "sof-explore-repository");
    expect(
      isConfigRuleManaged(manifest, "agent.plan.permission.task", "sof-*")
    ).toBe(true);
    // The build rules from sof-explore-repository are gone
    expect(
      isConfigRuleManaged(manifest, "agent.build.permission.task", "sof-*")
    ).toBe(false);
  });
});
