import type { ModelProviderType } from "@/lib/modelRouter";
import type { VirtualFile } from "./fileOps";
import type { SyntaxDiagnostic } from "./diagnostics";

export interface WorkspaceFileLike {
  name?: string;
  path?: string;
  code?: string;
}

export interface RepairPayload {
  files: VirtualFile[];
  provider?: ModelProviderType;
  model?: string;
  requestId: string;
}

export interface RepairApiResponse {
  success: boolean;
  requestId?: string;
  repaired?: boolean;
  attempts?: number;
  initialDiagnostics?: SyntaxDiagnostic[];
  remainingDiagnostics?: SyntaxDiagnostic[];
  files?: VirtualFile[];
  outcomeReason?: string;
  message?: string;
  usedModel?: string;
  usedProvider?: string;
}

/**
 * Builds the request payload for POST /api/agent self-repair endpoint.
 */
export function buildRepairPayload(
  files: WorkspaceFileLike[],
  provider?: ModelProviderType,
  model?: string,
  requestId?: string
): RepairPayload {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(
      "Cannot build repair payload: files list must be a non-empty array."
    );
  }

  const reqId =
    requestId && requestId.trim()
      ? requestId.trim()
      : `req-repair-${Math.random().toString(36).substring(2, 10)}`;

  const mappedFiles: VirtualFile[] = files.map((f, idx) => {
    const rawPath = f.path || f.name || `file_${idx}.tsx`;
    return {
      path: rawPath.trim(),
      code: typeof f.code === "string" ? f.code : "",
    };
  });

  return {
    files: mappedFiles,
    provider,
    model,
    requestId: reqId,
  };
}

/**
 * Computes a deterministic workspace fingerprint to detect state drift while an async repair is in flight.
 */
export function computeWorkspaceFingerprint(
  files: WorkspaceFileLike[]
): string {
  if (!Array.isArray(files)) return "";
  const normalized = files
    .map((f) => ({
      path: (f.path || f.name || "").trim(),
      code: typeof f.code === "string" ? f.code : "",
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return JSON.stringify(normalized);
}

/**
 * Determines whether the workspace has changed since the repair was requested.
 */
export function isWorkspaceStale(
  initialFingerprint: string,
  currentFiles: WorkspaceFileLike[]
): boolean {
  return computeWorkspaceFingerprint(currentFiles) !== initialFingerprint;
}

/**
 * Mutex / concurrency check for repair actions.
 */
export function canStartRepair(
  isBusy: boolean,
  isRepairing: boolean
): boolean {
  return !isBusy && !isRepairing;
}

/**
 * Safely truncates and cleans error messages for UI presentation.
 */
export function truncateErrorMessage(
  message: unknown,
  maxLength: number = 300
): string {
  if (typeof message !== "string") {
    return message == null ? "" : String(message);
  }
  const trimmed = message.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength).trimEnd() + "...";
}

/**
 * Deduplicates error messages, preserving their original order.
 */
export function deduplicateErrors(errors: unknown[]): string[] {
  if (!Array.isArray(errors)) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of errors) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }

  return result;
}

/**
 * Parses and validates the raw JSON response from POST /api/agent.
 */
export function parseRepairResponse(
  responseText: string
): RepairApiResponse {
  if (!responseText || typeof responseText !== "string" || !responseText.trim()) {
    throw new Error("The server returned an empty response.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("Invalid response format received from server.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Server response must be an object.");
  }

  const res = parsed as Record<string, unknown>;

  return {
    success: Boolean(res.success),
    requestId: typeof res.requestId === "string" ? res.requestId : undefined,
    repaired: typeof res.repaired === "boolean" ? res.repaired : undefined,
    attempts: typeof res.attempts === "number" ? res.attempts : undefined,
    initialDiagnostics: Array.isArray(res.initialDiagnostics)
      ? (res.initialDiagnostics as SyntaxDiagnostic[])
      : undefined,
    remainingDiagnostics: Array.isArray(res.remainingDiagnostics)
      ? (res.remainingDiagnostics as SyntaxDiagnostic[])
      : undefined,
    files: Array.isArray(res.files) ? (res.files as VirtualFile[]) : undefined,
    outcomeReason:
      typeof res.outcomeReason === "string" ? res.outcomeReason : undefined,
    message: typeof res.message === "string" ? res.message : undefined,
    usedModel: typeof res.usedModel === "string" ? res.usedModel : undefined,
    usedProvider:
      typeof res.usedProvider === "string" ? res.usedProvider : undefined,
  };
}

/**
 * Maps returned virtual files back to the UI workspace AppFile format.
 */
export function mapRepairedFilesToAppFiles(
  repairedFiles: Array<{ path?: string; name?: string; code?: string }>
): Array<{ name: string; code: string }> {
  if (!Array.isArray(repairedFiles)) return [];
  return repairedFiles.map((f, idx) => ({
    name: (f.name || f.path || `file_${idx}.tsx`).replace(/^\/+/, ""),
    code: typeof f.code === "string" ? f.code : "",
  }));
}
