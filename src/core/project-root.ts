import { resolve, join, dirname, normalize } from "node:path";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";

export interface ScopeResult {
  rootDir: string;
  configPath: string;
  agentsDir: string;
}

export interface ScopeOptions {
  project?: string;
  global?: boolean;
}

/**
 * Resolve the project root directory deterministically.
 *
 * - `--project <path>`: normalize path, verify directory exists, use as root
 * - `--global`: root = `~/.config/opencode/`
 * - Default (no flags): walk up from cwd to find `.git/`, fail if none found
 */
export async function resolveScope(
  options: ScopeOptions = {}
): Promise<ScopeResult> {
  if (options.global) {
    const rootDir = join(homedir(), ".config", "opencode");
    const agentsDir = join(rootDir, "agents");
    const configPath = findConfigPath(rootDir);
    return { rootDir, configPath, agentsDir };
  }

  if (options.project) {
    const rootDir = normalize(resolve(options.project));
    if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
      throw new Error(
        `Project directory does not exist or is not a directory: ${rootDir}`
      );
    }
    const agentsDir = join(rootDir, ".opencode", "agents");
    const configPath = findConfigPath(rootDir);
    return { rootDir, configPath, agentsDir };
  }

  // Default: discover nearest Git root by walking up from cwd
  const gitRoot = findGitRoot(process.cwd());
  if (!gitRoot) {
    throw new Error(
      "No Git repository found. Use --project <path> to specify the project root explicitly."
    );
  }
  const agentsDir = join(gitRoot, ".opencode", "agents");
  const configPath = findConfigPath(gitRoot);
  return { rootDir: gitRoot, configPath, agentsDir };
}

/**
 * Walk up from `startDir` looking for a directory containing `.git/`.
 * Returns the directory path if found, null otherwise.
 */
export function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const gitDir = join(dir, ".git");
    if (existsSync(gitDir) && statSync(gitDir).isDirectory()) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root without finding .git/
      return null;
    }
    dir = parent;
  }
}

/**
 * Determine the config file path for a given root directory.
 *
 * - Both `opencode.json` and `opencode.jsonc` exist → throw (ambiguous)
 * - `opencode.jsonc` exists → return it
 * - `opencode.json` exists → return it
 * - Neither exists → return `opencode.json` (to be created)
 */
export function findConfigPath(rootDir: string): string {
  const jsonPath = join(rootDir, "opencode.json");
  const jsoncPath = join(rootDir, "opencode.jsonc");

  const hasJson = existsSync(jsonPath);
  const hasJsonc = existsSync(jsoncPath);

  if (hasJson && hasJsonc) {
    throw new Error(
      `Ambiguous configuration: both opencode.json and opencode.jsonc exist in ${rootDir}. Remove one to proceed.`
    );
  }

  if (hasJsonc) return jsoncPath;
  if (hasJson) return jsonPath;

  // Neither exists — default to opencode.json (to be created)
  return jsonPath;
}
