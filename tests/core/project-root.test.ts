import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

// --- Mock state management ---
type FsEntry = { isDir?: boolean; isFile?: boolean };
let mockEntries: Record<string, FsEntry> | null = null;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (mockEntries === null) return actual.existsSync(p);
      const path = typeof p === "string" ? p : p.toString();
      return Object.keys(mockEntries).some(
        (key) => path === key || path.endsWith(key)
      );
    }),
    statSync: vi.fn((p: string) => {
      if (mockEntries === null) return actual.statSync(p);
      const path = typeof p === "string" ? p : p.toString();
      const entry = Object.entries(mockEntries).find(
        ([key]) => path === key || path.endsWith(key)
      );
      return {
        isDirectory: () => entry?.[1]?.isDir ?? false,
        isFile: () => entry?.[1]?.isFile ?? false,
      };
    }),
  };
});

const { findGitRoot, findConfigPath, resolveScope } = await import(
  "../../src/core/project-root.js"
);

function mockFs(entries: Record<string, FsEntry>) {
  mockEntries = entries;
}

function restoreFs() {
  mockEntries = null;
}

describe("findGitRoot", () => {
  beforeEach(() => {
    restoreFs();
  });

  it("returns the directory containing .git/ when found directly", () => {
    const projectDir = "/home/user/project";
    mockFs({
      [join(projectDir, ".git")]: { isDir: true },
    });
    expect(findGitRoot(projectDir)).toBe(projectDir);
  });

  it("walks up to find .git/ in parent directory", () => {
    const projectDir = "/home/user/project";
    const childDir = "/home/user/project/src/core";
    mockFs({
      [join(projectDir, ".git")]: { isDir: true },
    });
    expect(findGitRoot(childDir)).toBe(projectDir);
  });

  it("returns null when no .git/ found (reaches filesystem root)", () => {
    mockFs({});
    expect(findGitRoot("/some/deep/path")).toBeNull();
  });
});

describe("findConfigPath", () => {
  beforeEach(() => {
    restoreFs();
  });

  it("returns opencode.json when only it exists", () => {
    const rootDir = "/project";
    mockFs({
      [join(rootDir, "opencode.json")]: { isFile: true },
    });
    expect(findConfigPath(rootDir)).toBe(join(rootDir, "opencode.json"));
  });

  it("returns opencode.jsonc when only it exists", () => {
    const rootDir = "/project";
    mockFs({
      [join(rootDir, "opencode.jsonc")]: { isFile: true },
    });
    expect(findConfigPath(rootDir)).toBe(join(rootDir, "opencode.jsonc"));
  });

  it("throws when both opencode.json and opencode.jsonc exist", () => {
    const rootDir = "/project";
    mockFs({
      [join(rootDir, "opencode.json")]: { isFile: true },
      [join(rootDir, "opencode.jsonc")]: { isFile: true },
    });
    expect(() => findConfigPath(rootDir)).toThrow(/Ambiguous configuration/);
  });

  it("defaults to opencode.json when neither exists", () => {
    const rootDir = "/project";
    mockFs({});
    expect(findConfigPath(rootDir)).toBe(join(rootDir, "opencode.json"));
  });
});

describe("resolveScope", () => {
  beforeEach(() => {
    restoreFs();
  });

  it("resolves --project to the exact normalized path", async () => {
    const projectDir = resolve("/home/user/my-project");
    mockFs({
      [projectDir]: { isDir: true },
      [join(projectDir, "opencode.json")]: { isFile: true },
    });
    const result = await resolveScope({ project: projectDir });
    expect(result.rootDir).toBe(projectDir);
    expect(result.agentsDir).toBe(join(projectDir, ".opencode", "agents"));
    expect(result.configPath).toBe(join(projectDir, "opencode.json"));
  });

  it("normalizes relative --project path to absolute", async () => {
    const relativePath = "./some/../project";
    const absolutePath = resolve(relativePath);
    mockFs({
      [absolutePath]: { isDir: true },
    });
    const result = await resolveScope({ project: relativePath });
    expect(result.rootDir).toBe(absolutePath);
  });

  it("throws when --project directory does not exist", async () => {
    mockFs({});
    await expect(
      resolveScope({ project: "/nonexistent/path" })
    ).rejects.toThrow(/does not exist or is not a directory/);
  });

  it("throws when --project path is a file, not a directory", async () => {
    const filePath = "/home/user/file.txt";
    mockFs({
      [filePath]: { isFile: true },
    });
    await expect(resolveScope({ project: filePath })).rejects.toThrow(
      /does not exist or is not a directory/
    );
  });

  it("resolves --global to ~/.config/opencode/", async () => {
    const expectedRoot = join(homedir(), ".config", "opencode");
    mockFs({
      [join(expectedRoot, "opencode.json")]: { isFile: true },
    });
    const result = await resolveScope({ global: true });
    expect(result.rootDir).toBe(expectedRoot);
    expect(result.agentsDir).toBe(join(expectedRoot, "agents"));
    expect(result.configPath).toBe(join(expectedRoot, "opencode.json"));
  });

  it("discovers Git root when no flags provided (uses real cwd)", async () => {
    // mockEntries = null means real fs is used
    restoreFs();
    const result = await resolveScope();
    const cwd = process.cwd();
    expect(result.rootDir).toBe(cwd);
    expect(result.agentsDir).toBe(join(cwd, ".opencode", "agents"));
  });

  it("discovers Git root as the project root (not a subdirectory)", async () => {
    restoreFs();
    const cwd = process.cwd();
    const result = await resolveScope();
    expect(result.rootDir).toBe(cwd);
  });

  it("throws with clear error when no Git root found", async () => {
    const spy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/no-git-here");
    mockFs({});
    await expect(resolveScope()).rejects.toThrow(/No Git repository found/);
    spy.mockRestore();
  });
});
