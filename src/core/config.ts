import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseTree,
  findNodeAtLocation,
  modify,
  applyEdits,
  getNodeValue,
  type Node,
  type EditResult,
  type ParseError,
  type ModificationOptions,
} from "jsonc-parser";

// --- Types ---

export interface ConfigParseTree {
  /** Current text content (BOM stripped) */
  text: string;
  /** Original text from file (BOM stripped) */
  originalText: string;
  /** Parsed tree root node */
  root: Node;
  /** Whether the file had a UTF-8 BOM */
  hasBom: boolean;
  /** Absolute path to the config file */
  filePath: string;
}

export interface RuleChange {
  /** The rule key (e.g., "sof-*", "flow") */
  key: string;
  /** What happened to this rule */
  action: "inserted" | "changed" | "reordered";
  /** Previous value (for changed/reordered) */
  previousValue?: string;
  /** New value */
  newValue: string;
  /** Whether the rule was reordered for position safety (C-018) */
  reordered?: boolean;
  /** Original index before reorder */
  originalPosition?: number;
  /** Index after reorder */
  newPosition?: number;
}

export interface PatchResult {
  /** Whether any changes were made */
  modified: boolean;
  /** If scalar-to-object conversion occurred, records original value */
  scalarConversion?: {
    originalValue: string;
  };
  /** Individual rule changes */
  rules: RuleChange[];
}

// --- Managed deny rules ---

const MANAGED_DENY_KEYS = ["sof-*", "flow"] as const;
const MANAGED_DENY_VALUE = "deny";

// --- Core functions ---

/**
 * Read a JSONC config file and build a parse tree.
 * Detects and strips UTF-8 BOM, preserves it for later writing.
 */
export async function readConfigParseTree(
  configPath: string
): Promise<ConfigParseTree> {
  const absolutePath = path.resolve(configPath);
  const content = await fs.promises.readFile(absolutePath, "utf-8");

  // Detect BOM
  const hasBom = content.charCodeAt(0) === 0xfeff;
  const text = hasBom ? content.slice(1) : content;

  // Parse with jsonc-parser (fault-tolerant)
  const parseErrors: ParseError[] = [];
  const root = parseTree(text, parseErrors, {
    disallowComments: false,
    allowTrailingComma: true,
  });

  if (!root) {
    throw new Error(`Failed to parse JSONC config: ${absolutePath}`);
  }

  // Check for parse errors - reject severe errors
  const severeErrors = parseErrors.filter(
    (e) =>
      e.error !== 9 /* EndOfFileExpected is often benign */ &&
      e.error !== 10 /* InvalidCommentToken */
  );
  if (severeErrors.length > 0) {
    const errorMessages = severeErrors
      .map((e) => `Error at offset ${e.offset}: code ${e.error}`)
      .join(", ");
    throw new Error(
      `Malformed JSONC config at ${absolutePath}: ${errorMessages}`
    );
  }

  return {
    text,
    originalText: text,
    root,
    hasBom,
    filePath: absolutePath,
  };
}

/**
 * Navigate the parse tree to find a node at the given path segments.
 * Returns null if the path doesn't exist.
 */
export function findTaskNode(
  tree: ConfigParseTree,
  pathSegments: string[]
): Node | null {
  const node = findNodeAtLocation(tree.root, pathSegments);
  return node ?? null;
}

/**
 * Validate that there are no duplicate keys along the given path.
 * Throws if duplicate keys are found.
 */
export function validateNoDuplicateKeys(
  tree: ConfigParseTree,
  pathSegments: string[]
): void {
  let current = tree.root;
  for (const segment of pathSegments) {
    if (current.type !== "object" || !current.children) {
      // Path doesn't exist yet - that's OK
      return;
    }

    // Check for duplicate keys at this level
    const keys = new Set<string>();
    for (const child of current.children) {
      if (child.type === "property" && child.children && child.children[0]) {
        const keyNode = child.children[0];
        if (keyNode.type === "string" && keyNode.value !== undefined) {
          if (keys.has(keyNode.value)) {
            throw new Error(
              `Duplicate key "${keyNode.value}" found at path ` +
                `${pathSegments.slice(0, pathSegments.indexOf(segment) + 1).join(".")}`
            );
          }
          keys.add(keyNode.value);
        }
      }
    }

    // Navigate to the next level
    const property = current.children.find((child) => {
      if (child.type === "property" && child.children && child.children[0]) {
        return child.children[0].value === segment;
      }
      return false;
    });

    if (!property || !property.children || !property.children[1]) {
      // Path doesn't exist yet - that's OK
      return;
    }

    current = property.children[1];
  }
}

/**
 * Validate that all ancestors along the path are objects (not scalars/arrays).
 * Throws if an incompatible ancestor is found.
 */
export function validateAncestorsCompatible(
  tree: ConfigParseTree,
  pathSegments: string[]
): void {
  let current = tree.root;
  for (let i = 0; i < pathSegments.length - 1; i++) {
    const segment = pathSegments[i];

    if (current.type !== "object") {
      throw new Error(
        `Incompatible ancestor at path segment "${segment}": ` +
          `expected object but found ${current.type}`
      );
    }

    const property = current.children?.find((child) => {
      if (child.type === "property" && child.children && child.children[0]) {
        return child.children[0].value === segment;
      }
      return false;
    });

    if (!property || !property.children || !property.children[1]) {
      // Path doesn't exist yet - that's OK
      return;
    }

    const nextNode = property.children[1];
    if (nextNode.type !== "object" && nextNode.type !== "array") {
      // Check if it's a scalar at an intermediate path position
      if (i < pathSegments.length - 1) {
        throw new Error(
          `Incompatible ancestor at path "${pathSegments.slice(0, i + 1).join(".")}": ` +
            `expected object but found ${nextNode.type}`
        );
      }
    }

    current = nextNode;
  }
}

/**
 * Apply managed deny rules to the Task node at the specified path.
 * Handles scalar-to-object conversion, insertion, value updates, and position-aware reordering.
 */
export function applyManagedDenyRules(
  tree: ConfigParseTree,
  targetPath: string[]
): PatchResult {
  const result: PatchResult = {
    modified: false,
    rules: [],
  };

  const taskNode = findTaskNode(tree, targetPath);

  if (!taskNode) {
    // Task node doesn't exist - create it with managed rules
    const newTask: Record<string, string> = {};
    for (const key of MANAGED_DENY_KEYS) {
      newTask[key] = MANAGED_DENY_VALUE;
    }

    const edits = modify(tree.text, targetPath, newTask, {
      getInsertionIndex: (properties) => properties.length,
    });
    tree.text = applyEdits(tree.text, edits);
    result.modified = true;

    for (const key of MANAGED_DENY_KEYS) {
      result.rules.push({
        key,
        action: "inserted",
        newValue: MANAGED_DENY_VALUE,
      });
    }

    return result;
  }

  if (taskNode.type === "string") {
    // Scalar-to-object conversion
    const scalarValue = taskNode.value as string;
    const newTask: Record<string, string> = {
      "*": scalarValue,
    };
    for (const key of MANAGED_DENY_KEYS) {
      newTask[key] = MANAGED_DENY_VALUE;
    }

    const edits = modify(tree.text, targetPath, newTask, {
      getInsertionIndex: (properties) => properties.length,
    });
    tree.text = applyEdits(tree.text, edits);
    result.modified = true;
    result.scalarConversion = { originalValue: scalarValue };

    for (const key of MANAGED_DENY_KEYS) {
      result.rules.push({
        key,
        action: "inserted",
        newValue: MANAGED_DENY_VALUE,
      });
    }

    return result;
  }

  if (taskNode.type !== "object") {
    throw new Error(
      `Expected Task node to be object or string, but found ${taskNode.type}`
    );
  }

  // Object case - check existing properties
  const properties = taskNode.children ?? [];
  const existingKeys = new Map<string, { node: Node; index: number }>();

  for (let i = 0; i < properties.length; i++) {
    const prop = properties[i];
    if (prop.type === "property" && prop.children && prop.children[0]) {
      const keyNode = prop.children[0];
      if (keyNode.type === "string" && keyNode.value !== undefined) {
        existingKeys.set(keyNode.value, { node: prop, index: i });
      }
    }
  }

  const totalProperties = properties.length;

  // Find the index of the "*" wildcard rule (potential override) if it exists
  const wildcardEntry = existingKeys.get("*");
  const wildcardIndex = wildcardEntry?.index ?? -1;

  for (const managedKey of MANAGED_DENY_KEYS) {
    const existing = existingKeys.get(managedKey);

    if (!existing) {
      // Key doesn't exist - insert at end
      const edits = modify(
        tree.text,
        [...targetPath, managedKey],
        MANAGED_DENY_VALUE,
        {
          getInsertionIndex: (props) => props.length,
        }
      );
      tree.text = applyEdits(tree.text, edits);
      result.modified = true;
      result.rules.push({
        key: managedKey,
        action: "inserted",
        newValue: MANAGED_DENY_VALUE,
      });
    } else {
      // Key exists - check value and position
      const valueNode = existing.node.children?.[1];
      const currentValue = valueNode?.value as string | undefined;

      // Position-aware check (C-018):
      // A managed deny rule needs reordering only if a potential override ("*")
      // exists AFTER it. If "*" doesn't exist or is before the managed rule,
      // no reorder is needed.
      const hasOverrideAfter =
        wildcardIndex >= 0 && wildcardIndex > existing.index;

      if (currentValue !== MANAGED_DENY_VALUE) {
        // Wrong value - update
        const edits = modify(
          tree.text,
          [...targetPath, managedKey],
          MANAGED_DENY_VALUE,
          {}
        );
        tree.text = applyEdits(tree.text, edits);
        result.modified = true;
        result.rules.push({
          key: managedKey,
          action: "changed",
          previousValue: currentValue,
          newValue: MANAGED_DENY_VALUE,
        });
      } else if (hasOverrideAfter) {
        // Correct value but potential override ("*") follows - reorder (C-018)
        // Remove from current position and add at end
        const removeEdits = modify(
          tree.text,
          [...targetPath, managedKey],
          undefined,
          {}
        );
        const afterRemoval = applyEdits(tree.text, removeEdits);

        const addEdits = modify(
          afterRemoval,
          [...targetPath, managedKey],
          MANAGED_DENY_VALUE,
          {
            getInsertionIndex: (props) => props.length,
          }
        );
        tree.text = applyEdits(afterRemoval, addEdits);
        result.modified = true;
        result.rules.push({
          key: managedKey,
          action: "reordered",
          previousValue: MANAGED_DENY_VALUE,
          newValue: MANAGED_DENY_VALUE,
          reordered: true,
          originalPosition: existing.index,
          newPosition: totalProperties - 1,
        });
      } else {
        // Correct value AND no potential override after - no-op (C-018)
        result.rules.push({
          key: managedKey,
          action: "inserted", // represents "already correct"
          newValue: MANAGED_DENY_VALUE,
        });
      }
    }
  }

  return result;
}

/**
 * Write the patched config back to disk, preserving BOM if present.
 */
export async function writePatchedConfig(
  configPath: string,
  tree: ConfigParseTree
): Promise<void> {
  const absolutePath = path.resolve(configPath);
  const output = tree.hasBom ? "\uFEFF" + tree.text : tree.text;
  await fs.promises.writeFile(absolutePath, output, "utf-8");
}
