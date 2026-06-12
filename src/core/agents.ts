import { readdir, copyFile, mkdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

/**
 * Resolves to <package-root>/agents/.
 */
export function getPackageAgentDir(): string {
  return join(import.meta.dirname, "..", "..", "agents");
}

/**
 * Lists all .md files in the given agents directory.
 */
export async function getAgentFiles(agentsDir: string): Promise<string[]> {
  const entries = await readdir(agentsDir);
  return entries.filter((f) => f.endsWith(".md")).sort();
}

/**
 * Copies a single agent file from source to destDir.
 * If rename is provided, the destination filename is rename; otherwise uses the original filename.
 */
export async function copyAgent(
  source: string,
  destDir: string,
  rename?: string
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const destName = rename ?? basename(source);
  await copyFile(source, join(destDir, destName));
}

/**
 * Computes SHA-256 hex digest of a file.
 */
export async function computeHash(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Returns the rename mapping for agents.
 * 8 entries: old name -> sof- prefixed name.
 * flow.md is NOT in the map.
 */
export function getRenameMap(): Map<string, string> {
  return new Map([
    ["explore-repository.md", "sof-explore-repository.md"],
    ["design-change.md", "sof-design-change.md"],
    ["write-plan.md", "sof-write-plan.md"],
    ["review-plan.md", "sof-review-plan.md"],
    ["implement-task.md", "sof-implement-task.md"],
    ["review-code.md", "sof-review-code.md"],
    ["verify-release.md", "sof-verify-release.md"],
    ["audit-release.md", "sof-audit-release.md"],
  ]);
}
