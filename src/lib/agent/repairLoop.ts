import {
  VirtualWorkspace,
  VirtualFile,
  FileChangeOperation,
  WorkspaceError,
} from "./fileOps";
import {
  SyntaxDiagnostic,
  getWorkspaceSyntaxDiagnostics,
} from "./diagnostics";

export interface RepairContext {
  files: VirtualFile[];
  diagnostics: SyntaxDiagnostic[];
  attempt: number;
  maxAttempts: number;
}

export type RepairAction =
  | FileChangeOperation
  | { path: string; code: string; type?: "create" | "update" | "delete" };

export type RepairFunction = (
  context: RepairContext
) => Promise<readonly RepairAction[] | RepairAction[]> | readonly RepairAction[] | RepairAction[];

export interface RepairAttemptRecord {
  attempt: number;
  diagnosticsBefore: SyntaxDiagnostic[];
  changesApplied: number;
  diagnosticsAfter: SyntaxDiagnostic[];
}

export interface RepairResult {
  success: boolean;
  attempts: number;
  remainingDiagnostics: SyntaxDiagnostic[];
  outcomeReason: string;
  attemptHistory?: RepairAttemptRecord[];
  error?: unknown;
}

export interface RepairEngineOptions {
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 2;

function normalizeRepairActions(
  workspace: VirtualWorkspace,
  actions: readonly RepairAction[]
): FileChangeOperation[] {
  const normalized: FileChangeOperation[] = [];

  for (const action of actions) {
    if (!action || typeof action !== "object") {
      throw new WorkspaceError("Repair action must be a non-null object");
    }

    const path = typeof action.path === "string" ? action.path.trim() : "";
    if (!path) {
      throw new WorkspaceError("Repair action must include a valid 'path'");
    }

    const type = action.type;

    if (type === "delete") {
      normalized.push({ type: "delete", path });
      continue;
    }

    const code = typeof action.code === "string" ? action.code : "";

    if (type === "create") {
      normalized.push({ type: "create", path, code });
    } else if (type === "update") {
      normalized.push({ type: "update", path, code });
    } else if (type === undefined) {
      // Auto-detect create vs update based on file existence
      if (workspace.hasFile(path)) {
        normalized.push({ type: "update", path, code });
      } else {
        normalized.push({ type: "create", path, code });
      }
    } else {
      throw new WorkspaceError(
        `Unsupported repair action type: '${String(type)}'`
      );
    }
  }

  return normalized;
}

function hasMeaningfulProgress(
  workspace: VirtualWorkspace,
  operations: readonly FileChangeOperation[]
): boolean {
  if (operations.length === 0) {
    return false;
  }

  for (const op of operations) {
    if (op.type === "delete" || op.type === "create") {
      return true;
    }
    if (op.type === "update") {
      try {
        const currentCode = workspace.readFile(op.path);
        if (currentCode !== op.code) {
          return true;
        }
      } catch {
        // If file doesn't exist, let applyControlledChanges handle the error
        return true;
      }
    }
  }

  return false;
}

/**
 * Bounded Self-Repair Engine.
 *
 * Evaluates an in-memory VirtualWorkspace for TypeScript/TSX syntax errors,
 * executes targeted repair iterations using an injected repair function (at most 2 attempts),
 * validates all proposed file changes atomically, and verifies resulting syntax.
 */
export async function repairWorkspace(
  workspace: VirtualWorkspace,
  repairFn: RepairFunction,
  options?: RepairEngineOptions
): Promise<RepairResult> {
  const maxAttempts = Math.min(
    Math.max(options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1),
    DEFAULT_MAX_ATTEMPTS
  );

  let currentDiagnostics = getWorkspaceSyntaxDiagnostics(workspace);

  // Requirement 3: If already valid, return success without invoking the repair function
  if (currentDiagnostics.length === 0) {
    return {
      success: true,
      attempts: 0,
      remainingDiagnostics: [],
      outcomeReason: "Workspace already valid with no syntax errors.",
      attemptHistory: [],
    };
  }

  const attemptHistory: RepairAttemptRecord[] = [];
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    const diagnosticsBefore = currentDiagnostics;

    // Snapshot state before this attempt to guarantee atomicity on unexpected error
    const preAttemptSnapshot = workspace.clone();

    let rawActions: readonly RepairAction[] | RepairAction[];
    try {
      rawActions = await repairFn({
        files: workspace.listFiles(),
        diagnostics: currentDiagnostics,
        attempt,
        maxAttempts,
      });
    } catch (fnError) {
      const errMsg = fnError instanceof Error ? fnError.message : String(fnError);
      return {
        success: false,
        attempts: attempt,
        remainingDiagnostics: currentDiagnostics,
        outcomeReason: `Repair function threw an error: ${errMsg}`,
        attemptHistory,
        error: fnError,
      };
    }

    if (!Array.isArray(rawActions)) {
      return {
        success: false,
        attempts: attempt,
        remainingDiagnostics: currentDiagnostics,
        outcomeReason: "Repair function returned invalid changes (expected array).",
        attemptHistory,
      };
    }

    let normalizedOperations: FileChangeOperation[];
    try {
      normalizedOperations = normalizeRepairActions(workspace, rawActions);
    } catch (normError) {
      const errMsg =
        normError instanceof Error ? normError.message : String(normError);
      return {
        success: false,
        attempts: attempt,
        remainingDiagnostics: currentDiagnostics,
        outcomeReason: `Invalid repair operations: ${errMsg}`,
        attemptHistory,
      };
    }

    // Check for progress
    if (!hasMeaningfulProgress(workspace, normalizedOperations)) {
      return {
        success: false,
        attempts: attempt,
        remainingDiagnostics: currentDiagnostics,
        outcomeReason:
          normalizedOperations.length === 0
            ? "Repair function made no progress (returned 0 file changes)."
            : "Repair function made no progress (proposed changes are identical to existing files).",
        attemptHistory,
      };
    }

    // Apply changes through existing safe virtual file operations
    try {
      workspace.applyControlledChanges(normalizedOperations);
    } catch (applyError) {
      // Revert workspace to pre-attempt snapshot to ensure no partial corruption
      workspace.clear();
      for (const f of preAttemptSnapshot.listFiles()) {
        workspace.createFile(f.path, f.code);
      }

      const errMsg =
        applyError instanceof Error ? applyError.message : String(applyError);
      return {
        success: false,
        attempts: attempt,
        remainingDiagnostics: currentDiagnostics,
        outcomeReason: `Invalid file operations in repair batch: ${errMsg}`,
        attemptHistory,
      };
    }

    // Re-run diagnostics after repair
    currentDiagnostics = getWorkspaceSyntaxDiagnostics(workspace);

    attemptHistory.push({
      attempt,
      diagnosticsBefore,
      changesApplied: normalizedOperations.length,
      diagnosticsAfter: currentDiagnostics,
    });

    // Requirement 9: Stop immediately when diagnostics are cleared
    if (currentDiagnostics.length === 0) {
      return {
        success: true,
        attempts: attempt,
        remainingDiagnostics: [],
        outcomeReason: `Repaired successfully in ${attempt} attempt${
          attempt > 1 ? "s" : ""
        }.`,
        attemptHistory,
      };
    }
  }

  // Exhausted bounded attempts with diagnostics remaining
  return {
    success: false,
    attempts: attempt,
    remainingDiagnostics: currentDiagnostics,
    outcomeReason: `Repair failed: Syntax diagnostics remained after maximum ${maxAttempts} attempts.`,
    attemptHistory,
  };
}

export const runRepairLoop = repairWorkspace;
