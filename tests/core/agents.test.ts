import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getPackageAgentDir,
  getAgentFiles,
  copyAgent,
  computeHash,
  getRenameMap,
} from "../../src/core/agents.js";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "sample-agents");

describe("agents", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agents-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("getPackageAgentDir", () => {
    it("resolves to the agents/ directory at package root", () => {
      const dir = getPackageAgentDir();
      expect(dir).toMatch(/\/agents$/);
    });
  });

  describe("getAgentFiles", () => {
    it("lists .md files in the fixture directory", async () => {
      const files = await getAgentFiles(FIXTURES);
      expect(files).toEqual([
        "flow.md",
        "sof-design-change.md",
        "sof-explore-repository.md",
      ]);
    });
  });

  describe("copyAgent", () => {
    it("copies with rename when rename is provided", async () => {
      const source = join(FIXTURES, "sof-explore-repository.md");
      await copyAgent(source, tempDir, "explore-repository.md");
      const files = await readdir(tempDir);
      expect(files).toContain("explore-repository.md");
    });

    it("copies without rename for flow.md", async () => {
      const source = join(FIXTURES, "flow.md");
      await copyAgent(source, tempDir);
      const files = await readdir(tempDir);
      expect(files).toContain("flow.md");
    });
  });

  describe("computeHash", () => {
    it("computes SHA-256 of flow.md fixture", async () => {
      const hash = await computeHash(join(FIXTURES, "flow.md"));
      expect(hash).toBe(
        "e2d4cb343c9de39eeb1b606fac02a401b19932e72ceb7031e8b358ae5ea6870f"
      );
    });

    it("computes SHA-256 of sof-explore-repository.md fixture", async () => {
      const hash = await computeHash(
        join(FIXTURES, "sof-explore-repository.md")
      );
      expect(hash).toBe(
        "ec8bc0b6c1d31de235b07f178d68bb2667dc48e5b483df4e8c480553c3c3808d"
      );
    });

    it("computes SHA-256 of sof-design-change.md fixture", async () => {
      const hash = await computeHash(join(FIXTURES, "sof-design-change.md"));
      expect(hash).toBe(
        "7cca3ca9ae681a61398bb210ead738224bc925c81cdeb9d84b1af2420a4e9129"
      );
    });

    it("returns consistent hash for same file", async () => {
      const hash1 = await computeHash(join(FIXTURES, "flow.md"));
      const hash2 = await computeHash(join(FIXTURES, "flow.md"));
      expect(hash1).toBe(hash2);
    });
  });

  describe("getRenameMap", () => {
    it("has exactly 8 entries", () => {
      const map = getRenameMap();
      expect(map.size).toBe(8);
    });

    it("excludes flow.md", () => {
      const map = getRenameMap();
      expect(map.has("flow.md")).toBe(false);
    });

    it("maps old names to sof- prefixed names", () => {
      const map = getRenameMap();
      expect(map.get("explore-repository.md")).toBe(
        "sof-explore-repository.md"
      );
      expect(map.get("design-change.md")).toBe("sof-design-change.md");
      expect(map.get("write-plan.md")).toBe("sof-write-plan.md");
      expect(map.get("review-plan.md")).toBe("sof-review-plan.md");
      expect(map.get("implement-task.md")).toBe("sof-implement-task.md");
      expect(map.get("review-code.md")).toBe("sof-review-code.md");
      expect(map.get("verify-release.md")).toBe("sof-verify-release.md");
      expect(map.get("audit-release.md")).toBe("sof-audit-release.md");
    });
  });
});
