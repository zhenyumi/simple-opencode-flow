#!/usr/bin/env node
// sof CLI entry point: native argv parsing, no external framework.
// Exit codes: 0 success, 1 error, 2 conflict/blocked.

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { install } from "./commands/install.js";
import { update } from "./commands/update.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { runDoctor } from "./commands/doctor.js";
import type {
  InstallOptions,
  UpdateOptions,
  UninstallOptions,
  DoctorOptions,
} from "./types.js";

// ─── Version ────────────────────────────────────────────────────────────────

async function getVersion(): Promise<string> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Read from package.json in project root (one level up from dist/)
  const pkgPath = join(__dirname, "..", "package.json");
  const content = await readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(content) as { version: string };
  return pkg.version;
}

// ─── Help ───────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`sof — Simple OpenCode Flow installer

Usage:
  sof <command> [options]

Commands:
  install      Install agents and config protection
  update       Update installed agents
  uninstall    Remove agents and config protection
  doctor       Diagnose installation and protection status

Shared options:
  --project <path>   Use specific project directory
  --global           Use global config scope
  --help             Show help
  --version          Show version

Command options:
  install:    --dry-run --force --migrate-legacy
  update:     --dry-run --force
  uninstall:  --dry-run --force
  doctor:     --runtime`);
}

function showCommandHelp(command: string): void {
  const helpTexts: Record<string, string> = {
    install: `sof install — Install agents and config protection

Usage:
  sof install [options]

Options:
  --project <path>   Use specific project directory
  --global           Use global config scope
  --dry-run          Preview changes without writing
  --force            Overwrite conflicting files
  --migrate-legacy   Detect and migrate pre-sof agents
  --help             Show this help`,

    update: `sof update — Update installed agents

Usage:
  sof update [options]

Options:
  --project <path>   Use specific project directory
  --global           Use global config scope
  --dry-run          Preview changes without writing
  --force            Overwrite user-modified files
  --help             Show this help`,

    uninstall: `sof uninstall — Remove agents and config protection

Usage:
  sof uninstall [options]

Options:
  --project <path>   Use specific project directory
  --global           Use global config scope
  --dry-run          Preview changes without writing
  --force            Remove user-modified config rules
  --help             Show this help`,

    doctor: `sof doctor — Diagnose installation and protection status

Usage:
  sof doctor [options]

Options:
  --project <path>   Use specific project directory
  --global           Use global config scope
  --runtime          Check runtime OpenCode protection
  --help             Show this help`,
  };

  console.log(helpTexts[command] ?? `Unknown command: ${command}`);
}

// ─── Argument parsing ───────────────────────────────────────────────────────

interface ParsedArgs {
  command: string | null;
  options: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const options: Record<string, string | boolean> = {};
  let command: string | null = null;
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex !== -1) {
        // --key=value
        const key = arg.slice(2, eqIndex);
        const value = arg.slice(eqIndex + 1);
        options[key] = value;
      } else {
        // --flag or --key value
        const key = arg.slice(2);
        const nextArg = argv[i + 1];
        if (nextArg !== undefined && !nextArg.startsWith("--")) {
          options[key] = nextArg;
          i++;
        } else {
          options[key] = true;
        }
      }
    } else if (command === null) {
      command = arg;
    }

    i++;
  }

  return { command, options };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));

  // --version (global)
  if (options["version"]) {
    const version = await getVersion();
    console.log(version);
    process.exit(0);
  }

  // --help without command or --help with command
  if (options["help"]) {
    if (command) {
      showCommandHelp(command);
    } else {
      showHelp();
    }
    process.exit(0);
  }

  // No command
  if (!command) {
    showHelp();
    process.exit(1);
  }

  // Route command
  try {
    switch (command) {
      case "install": {
        const installOptions: InstallOptions = {
          projectDir: options["project"] as string | undefined,
          global: options["global"] === true,
          force: options["force"] === true,
          dryRun: options["dry-run"] === true,
          migrateLegacy: options["migrate-legacy"] === true,
        };
        const report = await install(installOptions);
        if (installOptions.dryRun) {
          console.log("Dry run report:");
          console.log(`  Would succeed: ${report.wouldSucceed}`);
          console.log(`  Conflicts: ${report.conflicts.length}`);
          for (const conflict of report.conflicts) {
            console.log(`    - ${conflict}`);
          }
          console.log(`  Operations: ${report.orderedOperations.length}`);
          console.log(`  Backups: ${report.backups.length}`);
        } else {
          console.log("Install completed successfully.");
        }
        break;
      }

      case "update": {
        const updateOptions: UpdateOptions = {
          projectDir: options["project"] as string | undefined,
          global: options["global"] === true,
          force: options["force"] === true,
          dryRun: options["dry-run"] === true,
        };
        const report = await update(updateOptions);
        if (updateOptions.dryRun) {
          console.log("Dry run report:");
          console.log(`  Would succeed: ${report.wouldSucceed}`);
          console.log(`  Conflicts: ${report.conflicts.length}`);
          for (const conflict of report.conflicts) {
            console.log(`    - ${conflict}`);
          }
          console.log(`  Operations: ${report.orderedOperations.length}`);
          console.log(`  Backups: ${report.backups.length}`);
        } else {
          console.log("Update completed successfully.");
        }
        break;
      }

      case "uninstall": {
        const uninstallOptions: UninstallOptions = {
          projectDir: options["project"] as string | undefined,
          global: options["global"] === true,
          force: options["force"] === true,
          dryRun: options["dry-run"] === true,
        };
        const result = await uninstallCommand(uninstallOptions);
        if (result.dryRun) {
          console.log("Dry run report:");
          if (result.report) {
            console.log(`  Would succeed: ${result.report.wouldSucceed}`);
            console.log(`  Conflicts: ${result.report.conflicts.length}`);
            for (const conflict of result.report.conflicts) {
              console.log(`    - ${conflict}`);
            }
            console.log(`  Operations: ${result.report.orderedOperations.length}`);
            console.log(`  Backups: ${result.report.backups.length}`);
          }
        } else {
          console.log("Uninstall completed successfully.");
        }
        break;
      }

      case "doctor": {
        const doctorOptions: DoctorOptions = {
          projectDir: options["project"] as string | undefined,
          global: options["global"] === true,
          runtime: options["runtime"] === true,
        };
        const report = await runDoctor(doctorOptions);

        // Display results
        console.log("=== sof doctor ===\n");

        console.log(`Selected-scope: ${report.selectedScope.status}`);
        if (report.selectedScope.detail) {
          console.log(`  ${report.selectedScope.detail}`);
        }

        console.log(`Plugin-free resolved: ${report.pluginFreeResolved.status}`);
        if (report.pluginFreeResolved.detail) {
          console.log(`  ${report.pluginFreeResolved.detail}`);
        }

        console.log(`Runtime: ${report.runtime.status}`);
        if (report.runtime.detail) {
          console.log(`  ${report.runtime.detail}`);
        }

        if (report.inconsistencies.length > 0) {
          console.log("\nInconsistencies:");
          for (const inc of report.inconsistencies) {
            console.log(`  [${inc.severity}] ${inc.type}: ${inc.detail}`);
          }
        }

        if (report.backupPaths.length > 0) {
          console.log("\nBackup paths:");
          for (const path of report.backupPaths) {
            console.log(`  ${path}`);
          }
        }

        // Determine exit code based on protection status
        const statuses = [
          report.selectedScope.status,
          report.pluginFreeResolved.status,
          report.runtime.status,
        ];
        const hasFail = statuses.some((s) => s === "FAIL");
        const hasWarn = statuses.some((s) => s === "WARN");
        const hasInconsistencyFail = report.inconsistencies.some(
          (i) => i.severity === "FAIL"
        );

        if (hasFail || hasInconsistencyFail) {
          process.exitCode = 1;
        } else if (hasWarn) {
          process.exitCode = 0; // Warnings are informational
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error("Run 'sof --help' for available commands.");
        process.exit(1);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);

    // Exit code 2 for conflict/blocked errors
    if (
      message.includes("blocked") ||
      message.includes("conflict") ||
      message.includes("Cannot uninstall")
    ) {
      process.exit(2);
    }

    process.exit(1);
  }
}

main();
