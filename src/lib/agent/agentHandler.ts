import { NextResponse } from "next/server";
import {
  modelRouter,
  AVAILABLE_PROVIDERS,
  getErrorStatusCode,
  sanitizeErrorMessage,
  type ModelProviderType,
  type ModelRouter,
} from "@/lib/modelRouter";
import {
  VirtualWorkspace,
  type VirtualFile,
  type FileChangeOperation,
  normalizeWorkspacePath,
} from "@/lib/agent/fileOps";
import {
  type SyntaxDiagnostic,
  getWorkspaceSyntaxDiagnostics,
  formatDiagnostic,
} from "@/lib/agent/diagnostics";
import {
  repairWorkspace,
  type RepairFunction,
  type RepairContext,
  type RepairResult,
} from "@/lib/agent/repairLoop";
import {
  MetaResponsesClient,
  executeResponsesRepair,
} from "@/lib/agent/metaResponsesClient";
import {
  enforceRouteRateLimit,
  defaultConcurrencyLimiter,
  type IRateLimiter,
  type ConcurrencyLimiter,
} from "@/lib/rateLimiter";

const MAX_FILES_LIMIT = 50;
const MAX_TOTAL_CODE_LENGTH = 500_000;

function sanitizeJsonControlCharacters(raw: string): string {
  let result = "";
  let insideString = false;
  let isEscaped = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    const code = raw.charCodeAt(i);

    if (insideString && !isEscaped && code >= 0x00 && code <= 0x1f) {
      switch (char) {
        case "\n":
          result += "\\n";
          break;
        case "\r":
          result += "\\r";
          break;
        case "\t":
          result += "\\t";
          break;
        default:
          result += "\\u" + code.toString(16).padStart(4, "0");
      }
      continue;
    }

    result += char;

    if (char === '"' && !isEscaped) {
      insideString = !insideString;
    }

    isEscaped = char === "\\" && !isEscaped;
  }

  return result;
}

export function buildRepairPrompt(
  files: VirtualFile[],
  diagnostics: SyntaxDiagnostic[],
  attempt: number
): string {
  const formattedDiags = diagnostics.map((d) => formatDiagnostic(d)).join("\n");
  const fileContents = files
    .map((f) => `File: ${f.path}\n\`\`\`\n${f.code}\n\`\`\``)
    .join("\n\n");

  return `You are an automated code repair agent. The project currently has TypeScript/TSX syntax errors that must be fixed.

Current Project Files:
${fileContents}

TypeScript Compiler Diagnostics (Attempt ${attempt}):
${formattedDiags}

Task:
Fix the syntax errors above while strictly preserving the existing functionality and design.
Make only targeted corrections necessary to resolve the syntax errors.

Return ONLY valid JSON matching this exact structure:
{
  "changedFiles": [
    {
      "path": "App.tsx",
      "code": "complete fixed code for this file"
    }
  ]
}

Rules:
- Return the COMPLETE source code for any file that is modified. Do not use snippets or "rest of code here" placeholders.
- Only return files that were actually modified.
- Return ONLY JSON. Do not include markdown formatting or prose outside the JSON object.
- Every parenthesis, bracket, brace, and JSX element must be balanced and properly closed.
`;
}

export function parseRepairOutput(output: string): FileChangeOperation[] {
  if (!output || typeof output !== "string") {
    throw new Error("Model returned empty or non-string response.");
  }

  const cleanOutput = output
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const start = cleanOutput.indexOf("{");
  const end = cleanOutput.lastIndexOf("}");

  if (start === -1 || end === -1) {
    throw new Error("Model did not return a valid JSON object.");
  }

  const jsonText = cleanOutput.slice(start, end + 1);
  const sanitized = sanitizeJsonControlCharacters(jsonText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(sanitized);
  } catch (err) {
    throw new Error(
      `Failed to parse model repair response JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model response must be an object with a 'changedFiles' array.");
  }

  const changedFiles = (parsed as { changedFiles?: unknown }).changedFiles;
  if (!Array.isArray(changedFiles)) {
    throw new Error("Model response must contain a 'changedFiles' array.");
  }

  const operations: FileChangeOperation[] = [];
  for (const item of changedFiles) {
    if (!item || typeof item !== "object") continue;
    const rawPath = typeof item.path === "string" ? item.path.trim() : "";
    const code = typeof item.code === "string" ? item.code : "";
    if (rawPath && typeof code === "string") {
      operations.push({
        type: "update",
        path: rawPath,
        code,
      });
    }
  }

  return operations;
}

export function createModelRouterRepairFunction(options: {
  router?: ModelRouter;
  provider: ModelProviderType;
  model: string;
  requestId?: string;
  disableFallback?: boolean;
  concurrencyLimiter?: ConcurrencyLimiter;
}): RepairFunction {
  const router = options.router || modelRouter;
  const concurrencyLimiter = options.concurrencyLimiter || defaultConcurrencyLimiter;

  return async (context: RepairContext): Promise<FileChangeOperation[]> => {
    const prompt = buildRepairPrompt(
      context.files,
      context.diagnostics,
      context.attempt
    );

    const result = await concurrencyLimiter.execute(() =>
      router.generateWithFallback(
        {
          model: options.model,
          input: prompt,
          generationConfig: {
            thinking_level: "low",
          },
          responseFormat: {
            type: "text",
            mime_type: "application/json",
            schema: {
              type: "object",
              properties: {
                changedFiles: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      code: { type: "string" },
                    },
                    required: ["path", "code"],
                  },
                },
              },
              required: ["changedFiles"],
            },
          },
          requestId: options.requestId,
          disableFallback: options.disableFallback ?? true,
        },
        options.provider
      )
    );

    return parseRepairOutput(result.response.outputText);
  };
}

export interface AgentRouteDependencies {
  repairFn?: RepairFunction;
  responsesClient?: MetaResponsesClient;
  router?: ModelRouter;
  rateLimiter?: IRateLimiter;
  concurrencyLimiter?: ConcurrencyLimiter;
}

export async function handleAgentRequest(
  request: Request,
  dependencies: AgentRouteDependencies = {}
) {
  const serverReqId = Math.random().toString(36).substring(2, 10);
  const startTime = Date.now();

  const rateLimitCheck = await enforceRouteRateLimit(request, "agent", {
    limiter: dependencies.rateLimiter,
    requestId: serverReqId,
  });

  if (!rateLimitCheck.allowed) {
    return rateLimitCheck.response;
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        requestId: serverReqId,
        message: "Invalid JSON request body.",
      },
      { status: 400 }
    );
  }

  try {
    const reqId =
      typeof body?.requestId === "string" && body.requestId.trim()
        ? body.requestId.trim()
        : serverReqId;

    const rawFiles = Array.isArray(body?.files) ? body.files : null;
    if (!rawFiles || rawFiles.length === 0) {
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: "Please provide project files to inspect and repair.",
        },
        { status: 400 }
      );
    }

    if (rawFiles.length > MAX_FILES_LIMIT) {
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: `File count exceeds maximum allowed limit of ${MAX_FILES_LIMIT} files.`,
        },
        { status: 400 }
      );
    }

    let totalCodeLength = 0;
    const validatedFiles: VirtualFile[] = [];

    for (const f of rawFiles) {
      if (!f || typeof f !== "object") {
        return NextResponse.json(
          {
            success: false,
            requestId: reqId,
            message: "Each file entry must be a valid object.",
          },
          { status: 400 }
        );
      }

      const rawPath =
        typeof (f as { path?: unknown }).path === "string"
          ? ((f as { path: string }).path as string)
          : typeof (f as { name?: unknown }).name === "string"
          ? ((f as { name: string }).name as string)
          : "";

      const code =
        typeof (f as { code?: unknown }).code === "string"
          ? (f as { code: string }).code
          : "";

      if (!rawPath.trim()) {
        return NextResponse.json(
          {
            success: false,
            requestId: reqId,
            message: "Each file must have a non-empty 'path' or 'name'.",
          },
          { status: 400 }
        );
      }

      let normalizedPath: string;
      try {
        normalizedPath = normalizeWorkspacePath(rawPath);
      } catch (pathErr) {
        return NextResponse.json(
          {
            success: false,
            requestId: reqId,
            message:
              pathErr instanceof Error
                ? pathErr.message
                : `Invalid path: '${rawPath}'`,
          },
          { status: 400 }
        );
      }

      totalCodeLength += code.length;
      validatedFiles.push({ path: normalizedPath, code });
    }

    if (totalCodeLength > MAX_TOTAL_CODE_LENGTH) {
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: `Project files exceed maximum allowed size of ${MAX_TOTAL_CODE_LENGTH.toLocaleString()} characters.`,
        },
        { status: 400 }
      );
    }

    // Resolve provider & model configuration
    const rawProvider =
      typeof body?.provider === "string" && body.provider.trim()
        ? body.provider.trim()
        : process.env.AI_PROVIDER || "meta";

    const providerConfig = AVAILABLE_PROVIDERS.find(
      (p) => p.provider === rawProvider
    );

    if (!providerConfig) {
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: `Selected provider '${rawProvider}' is not available or registered.`,
        },
        { status: 400 }
      );
    }

    const providerType = providerConfig.provider;
    const requestedModel =
      typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : undefined;

    const modelToUse =
      requestedModel ||
      providerConfig.models.find((m) => m.isDefault)?.id ||
      providerConfig.models[0]?.id ||
      "";

    const isModelValid = providerConfig.models.some((m) => m.id === modelToUse);
    if (!isModelValid) {
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: `Selected model '${modelToUse}' is not available for provider '${providerType}'.`,
        },
        { status: 400 }
      );
    }

    // Initialize in-memory workspace
    const workspace = new VirtualWorkspace(validatedFiles);
    const initialDiagnostics = getWorkspaceSyntaxDiagnostics(workspace);

    // Fast-path: If there are no syntax errors, return immediately
    if (initialDiagnostics.length === 0) {
      return NextResponse.json({
        success: true,
        requestId: reqId,
        repaired: false,
        attempts: 0,
        initialDiagnostics: [],
        remainingDiagnostics: [],
        files: workspace.listFiles(),
        outcomeReason: "Workspace already valid with no syntax errors.",
        usedModel: modelToUse,
        usedProvider: providerType,
      });
    }

    let repairResult: RepairResult;

    if (dependencies?.repairFn) {
      // Injected repair function (for mock tests)
      repairResult = await repairWorkspace(workspace, dependencies.repairFn, {
        maxAttempts: 2,
      });
    } else if (dependencies?.router) {
      // Injected ModelRouter (for backwards compatibility with router mock tests)
      const activeRepairFn = createModelRouterRepairFunction({
        router: dependencies.router,
        provider: providerType,
        model: modelToUse,
        requestId: reqId,
        disableFallback: true,
        concurrencyLimiter: dependencies?.concurrencyLimiter,
      });
      repairResult = await repairWorkspace(workspace, activeRepairFn, {
        maxAttempts: 2,
      });
    } else {
      // Production Meta Model API Responses API agent repair workflow
      const responsesClient =
        dependencies?.responsesClient || new MetaResponsesClient();
      const activeConcurrencyLimiter =
        dependencies?.concurrencyLimiter || defaultConcurrencyLimiter;

      repairResult = await activeConcurrencyLimiter.execute(() =>
        executeResponsesRepair(workspace, responsesClient, {
          model: modelToUse,
          requestId: reqId,
          maxIterations: 3,
        })
      );
    }

    if (repairResult.error) {
      throw repairResult.error;
    }

    const duration = Date.now() - startTime;
    console.log(
      `[Req ${reqId}] Agent repair finished in ${duration}ms. Success: ${repairResult.success}, Attempts: ${repairResult.attempts}`
    );

    return NextResponse.json({
      success: repairResult.success,
      requestId: reqId,
      repaired: repairResult.success && repairResult.attempts > 0,
      attempts: repairResult.attempts,
      initialDiagnostics,
      remainingDiagnostics: repairResult.remainingDiagnostics,
      files: workspace.listFiles(),
      outcomeReason: sanitizeErrorMessage(repairResult.outcomeReason),
      attemptHistory: repairResult.attemptHistory,
      usedModel: modelToUse,
      usedProvider: providerType,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Req ${serverReqId}] Agent API error after ${duration}ms:`, error);

    const statusCode = getErrorStatusCode(error);
    const rawMessage =
      error instanceof Error ? error.message : "An unexpected repair error occurred.";
    const safeMessage = sanitizeErrorMessage(rawMessage);

    const headers: Record<string, string> = {};
    if (statusCode === 429) {
      const retryAfter =
        (error as { retryAfter?: number })?.retryAfter ??
        (error as { retryAfterSeconds?: number })?.retryAfterSeconds ??
        5;
      headers["Retry-After"] = String(retryAfter);
    }

    return NextResponse.json(
      {
        success: false,
        requestId: serverReqId,
        message: safeMessage,
      },
      { status: statusCode, headers }
    );
  }
}
