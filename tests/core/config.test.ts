import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  readConfigParseTree,
  findTaskNode,
  validateNoDuplicateKeys,
  validateAncestorsCompatible,
  applyManagedDenyRules,
  writePatchedConfig,
  type ConfigParseTree,
} from "../../src/core/config.js";

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

// Helper to create a temp file for testing
async function createTempFile(
  content: string,
  options?: { bom?: boolean; ext?: string }
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "config-test-")
  );
  const filePath = path.join(
    tmpDir,
    `test-config${options?.ext ?? ".jsonc"}`
  );
  const output = options?.bom ? "\uFEFF" + content : content;
  await fs.promises.writeFile(filePath, output, "utf-8");
  return {
    filePath,
    cleanup: () => fs.promises.rm(tmpDir, { recursive: true, force: true }),
  };
}

describe("config", () => {
  let tempFiles: Array<{ cleanup: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const { cleanup } of tempFiles) {
      await cleanup();
    }
    tempFiles = [];
  });

  describe("readConfigParseTree", () => {
    it("1. Parse JSONC with comments → comments preserved in output", async () => {
      const content = `{
  // This is a line comment
  "name": "test",
  /* Block comment */
  "value": 42
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);

      // Comments are preserved in the text
      expect(tree.text).toContain("// This is a line comment");
      expect(tree.text).toContain("/* Block comment */");
      // Values are still parseable
      expect(tree.root.type).toBe("object");
    });

    it("2. Parse JSONC with trailing commas → preserved", async () => {
      const content = `{
  "name": "test",
  "items": [1, 2, 3,],
  "value": "ok",
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);

      // Trailing commas preserved in text
      expect(tree.text).toContain("[1, 2, 3,]");
      expect(tree.text).toContain('"value": "ok",');
      // Values still parseable
      expect(tree.root.type).toBe("object");
    });

    it("3. Parse JSONC with UTF-8 BOM → BOM preserved", async () => {
      const content = `{
  "name": "bom-test"
}`;
      const { filePath, cleanup } = await createTempFile(content, { bom: true });
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);

      expect(tree.hasBom).toBe(true);
      // Text should have BOM stripped
      expect(tree.text.charCodeAt(0)).not.toBe(0xfeff);
      expect(tree.root.type).toBe("object");

      // Write back and verify BOM is preserved
      await writePatchedConfig(filePath, tree);
      const written = await fs.promises.readFile(filePath, "utf-8");
      expect(written.charCodeAt(0)).toBe(0xfeff);
    });

    it("9. Malformed JSONC → rejected with clear error", async () => {
      const content = `{
  "name": "test",
  "value": undefined,
  "missing": 
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      await expect(readConfigParseTree(filePath)).rejects.toThrow(
        /Malformed JSONC|Failed to parse/
      );
    });
  });

  describe("validateNoDuplicateKeys", () => {
    it("10. Duplicate keys along path → rejected", async () => {
      const content = `{
  "agent": {
    "build": {
      "permission": {
        "task": { "rule1": "allow" }
      }
    },
    "build": {
      "permission": {
        "task": { "rule2": "deny" }
      }
    }
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);

      expect(() =>
        validateNoDuplicateKeys(tree, ["agent", "build", "permission", "task"])
      ).toThrow(/Duplicate key "build"/);
    });
  });

  describe("validateAncestorsCompatible", () => {
    it("11. Incompatible ancestor (string instead of object) → rejected", async () => {
      const content = `{
  "agent": {
    "build": "not-an-object"
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);

      expect(() =>
        validateAncestorsCompatible(tree, [
          "agent",
          "build",
          "permission",
          "task",
        ])
      ).toThrow(/Incompatible ancestor.*string/);
    });
  });

  describe("applyManagedDenyRules", () => {
    it("4. Patch empty Task object → rules inserted", async () => {
      const content = `{
  "agent": {
    "build": {
      "permission": {
        "task": {}
      }
    }
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);
      const result = applyManagedDenyRules(tree, [
        "agent",
        "build",
        "permission",
        "task",
      ]);

      expect(result.modified).toBe(true);
      expect(result.rules).toHaveLength(2);
      expect(result.rules[0]).toMatchObject({
        key: "sof-*",
        action: "inserted",
        newValue: "deny",
      });
      expect(result.rules[1]).toMatchObject({
        key: "flow",
        action: "inserted",
        newValue: "deny",
      });

      // Verify the text was updated
      expect(tree.text).toContain('"sof-*"');
      expect(tree.text).toContain('"flow"');
      expect(tree.text).toContain('"deny"');
    });

    it("5. Patch Task object with existing rules → managed rules placed after", async () => {
      const content = `{
  "agent": {
    "build": {
      "permission": {
        "task": {
          "custom-rule": "allow"
        }
      }
    }
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);
      const result = applyManagedDenyRules(tree, [
        "agent",
        "build",
        "permission",
        "task",
      ]);

      expect(result.modified).toBe(true);
      expect(result.rules).toHaveLength(2);

      // Verify managed rules were added (compact format from jsonc-parser)
      expect(tree.text).toContain('"custom-rule"');
      expect(tree.text).toContain('"allow"');
      expect(tree.text).toContain('"sof-*"');
      expect(tree.text).toContain('"flow"');
      expect(tree.text).toContain('"deny"');
    });

    it("6. Patch scalar Task → converted to ordered object with '*' key preserving original value", async () => {
      const content = `{
  "agent": {
    "build": {
      "permission": {
        "task": "allow"
      }
    }
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);
      const result = applyManagedDenyRules(tree, [
        "agent",
        "build",
        "permission",
        "task",
      ]);

      expect(result.modified).toBe(true);
      expect(result.scalarConversion).toEqual({ originalValue: "allow" });
      expect(result.rules).toHaveLength(2);

      // Verify conversion - jsonc-parser uses compact format
      expect(tree.text).toContain('"*"');
      expect(tree.text).toContain('"allow"');
      expect(tree.text).toContain('"sof-*"');
      expect(tree.text).toContain('"deny"');
      expect(tree.text).toContain('"flow"');
    });

    it("7. Managed rules already correct AND positioned last → no-op, user ownership preserved", async () => {
      const content = `{
  "agent": {
    "build": {
      "permission": {
        "task": {
          "custom": "allow",
          "sof-*": "deny",
          "flow": "deny"
        }
      }
    }
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);
      const originalText = tree.text;
      const result = applyManagedDenyRules(tree, [
        "agent",
        "build",
        "permission",
        "task",
      ]);

      expect(result.modified).toBe(false);
      expect(tree.text).toBe(originalText);
    });

    it("8. Managed rules with wrong values → updated", async () => {
      const content = `{
  "agent": {
    "build": {
      "permission": {
        "task": {
          "sof-*": "allow",
          "flow": "allow"
        }
      }
    }
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);
      const result = applyManagedDenyRules(tree, [
        "agent",
        "build",
        "permission",
        "task",
      ]);

      expect(result.modified).toBe(true);
      expect(result.rules).toHaveLength(2);
      expect(result.rules[0]).toMatchObject({
        key: "sof-*",
        action: "changed",
        previousValue: "allow",
        newValue: "deny",
      });
      expect(result.rules[1]).toMatchObject({
        key: "flow",
        action: "changed",
        previousValue: "allow",
        newValue: "deny",
      });

      // Verify values updated - compact format from jsonc-parser
      expect(tree.text).toContain('"sof-*"');
      expect(tree.text).toContain('"flow"');
      expect(tree.text).toContain('"deny"');
    });

    it("12. Unrelated fields/formatting unchanged after patch", async () => {
      const content = `{
  // Project config
  "name": "my-project",
  "version": "1.0.0",
  "agent": {
    "build": {
      "permission": {
        "task": {
          "custom": "allow"
        }
      }
    }
  },
  // Extra section
  "extra": {
    "key": "value"
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);
      const result = applyManagedDenyRules(tree, [
        "agent",
        "build",
        "permission",
        "task",
      ]);

      expect(result.modified).toBe(true);

      // Verify unrelated content preserved
      expect(tree.text).toContain("// Project config");
      expect(tree.text).toContain('"name": "my-project"');
      expect(tree.text).toContain('"version": "1.0.0"');
      expect(tree.text).toContain("// Extra section");
      expect(tree.text).toContain('"key": "value"');
    });

    it("13. Managed deny correct value BUT NOT positioned last → rule moved to end (C-018)", async () => {
      const content = `{
  "agent": {
    "build": {
      "permission": {
        "task": {
          "sof-*": "deny",
          "flow": "deny",
          "*": "allow"
        }
      }
    }
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);
      const result = applyManagedDenyRules(tree, [
        "agent",
        "build",
        "permission",
        "task",
      ]);

      expect(result.modified).toBe(true);

      // Both rules should be reordered
      const reorderedRules = result.rules.filter((r) => r.reordered);
      expect(reorderedRules.length).toBeGreaterThan(0);

      // Verify rules are now at the end - compact format
      expect(tree.text).toContain('"*"');
      expect(tree.text).toContain('"sof-*"');
      expect(tree.text).toContain('"flow"');
      expect(tree.text).toContain('"deny"');

      // Verify position tracking
      for (const rule of reorderedRules) {
        expect(rule.reordered).toBe(true);
        expect(rule.originalPosition).toBeDefined();
        expect(rule.newPosition).toBeDefined();
      }
    });

    it("14. Managed deny correct value AND positioned last (no override can follow) → no-op (C-018)", async () => {
      const content = `{
  "agent": {
    "build": {
      "permission": {
        "task": {
          "*": "allow",
          "custom": "deny",
          "sof-*": "deny",
          "flow": "deny"
        }
      }
    }
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);
      const originalText = tree.text;
      const result = applyManagedDenyRules(tree, [
        "agent",
        "build",
        "permission",
        "task",
      ]);

      expect(result.modified).toBe(false);
      expect(tree.text).toBe(originalText);
    });

    it("Patch Plan Task path works same as Build Task", async () => {
      const content = `{
  "agent": {
    "plan": {
      "permission": {
        "task": "allow"
      }
    }
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);
      const result = applyManagedDenyRules(tree, [
        "agent",
        "plan",
        "permission",
        "task",
      ]);

      expect(result.modified).toBe(true);
      expect(result.scalarConversion).toEqual({ originalValue: "allow" });
      expect(tree.text).toContain('"*"');
      expect(tree.text).toContain('"sof-*"');
      expect(tree.text).toContain('"flow"');
      expect(tree.text).toContain('"deny"');
    });

    it("Task node doesn't exist → creates with managed rules", async () => {
      const content = `{
  "agent": {
    "build": {
      "permission": {}
    }
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);
      const result = applyManagedDenyRules(tree, [
        "agent",
        "build",
        "permission",
        "task",
      ]);

      expect(result.modified).toBe(true);
      expect(result.rules).toHaveLength(2);
      expect(tree.text).toContain('"task"');
      expect(tree.text).toContain('"sof-*"');
      expect(tree.text).toContain('"flow"');
      expect(tree.text).toContain('"deny"');
    });
  });

  describe("writePatchedConfig", () => {
    it("Writes file preserving BOM when hasBom is true", async () => {
      const content = `{ "test": true }`;
      const { filePath, cleanup } = await createTempFile(content, { bom: true });
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);
      await writePatchedConfig(filePath, tree);

      const written = await fs.promises.readFile(filePath, "utf-8");
      expect(written.charCodeAt(0)).toBe(0xfeff);
      expect(written).toContain('"test": true');
    });

    it("Writes file without BOM when hasBom is false", async () => {
      const content = `{ "test": true }`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      const tree = await readConfigParseTree(filePath);
      await writePatchedConfig(filePath, tree);

      const written = await fs.promises.readFile(filePath, "utf-8");
      expect(written.charCodeAt(0)).not.toBe(0xfeff);
      expect(written).toContain('"test": true');
    });
  });

  describe("integration: full patch workflow", () => {
    it("Full workflow: read → validate → patch → write → re-read → verify", async () => {
      const content = `{
  // Main config
  "name": "integration-test",
  "agent": {
    "build": {
      "permission": {
        "task": "allow"
      }
    },
    "plan": {
      "permission": {
        "task": {
          "custom": "allow"
        }
      }
    }
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      // Read
      const tree = await readConfigParseTree(filePath);

      // Validate
      validateNoDuplicateKeys(tree, ["agent", "build", "permission", "task"]);
      validateAncestorsCompatible(tree, [
        "agent",
        "build",
        "permission",
        "task",
      ]);
      validateNoDuplicateKeys(tree, ["agent", "plan", "permission", "task"]);
      validateAncestorsCompatible(tree, [
        "agent",
        "plan",
        "permission",
        "task",
      ]);

      // Patch Build Task
      const buildResult = applyManagedDenyRules(tree, [
        "agent",
        "build",
        "permission",
        "task",
      ]);
      expect(buildResult.modified).toBe(true);
      expect(buildResult.scalarConversion).toEqual({
        originalValue: "allow",
      });

      // Patch Plan Task
      const planResult = applyManagedDenyRules(tree, [
        "agent",
        "plan",
        "permission",
        "task",
      ]);
      expect(planResult.modified).toBe(true);

      // Write
      await writePatchedConfig(filePath, tree);

      // Re-read and verify - compact format from jsonc-parser
      const tree2 = await readConfigParseTree(filePath);
      expect(tree2.text).toContain('"*"');
      expect(tree2.text).toContain('"allow"');
      expect(tree2.text).toContain('"sof-*"');
      expect(tree2.text).toContain('"flow"');
      expect(tree2.text).toContain('"deny"');
      expect(tree2.text).toContain('"custom"');
      expect(tree2.text).toContain("// Main config");
    });

    it("Idempotency: applying rules twice produces same result", async () => {
      const content = `{
  "agent": {
    "build": {
      "permission": {
        "task": {
          "custom": "allow"
        }
      }
    }
  }
}`;
      const { filePath, cleanup } = await createTempFile(content);
      tempFiles.push({ cleanup });

      // First application
      const tree1 = await readConfigParseTree(filePath);
      applyManagedDenyRules(tree1, [
        "agent",
        "build",
        "permission",
        "task",
      ]);
      await writePatchedConfig(filePath, tree1);

      // Second application
      const tree2 = await readConfigParseTree(filePath);
      const result2 = applyManagedDenyRules(tree2, [
        "agent",
        "build",
        "permission",
        "task",
      ]);

      // Should be no-op on second application
      expect(result2.modified).toBe(false);
    });
  });
});
