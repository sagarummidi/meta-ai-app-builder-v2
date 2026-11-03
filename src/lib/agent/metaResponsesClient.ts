import {
  VirtualWorkspace,
  normalizeWorkspacePath,
  type VirtualFile,
} from "./fileOps";
import {
  getWorkspaceSyntaxDiagnostics,
  formatDiagnostic,
} from "./diagnostics";
import { sanitizeErrorMessage } from "@/lib/modelRouter";
import type { RepairAttemptRecord, RepairResult } from "./repairLoop";

export interface MetaResponsesClientConfig {
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

export interface ResponsesToolFunction {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface FunctionCallItem {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

export interface MessageItem {
  type: "message";
  role: string;
  content: Array<{ type: string; text?: string }> | string;
}

export interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponseOutputItem =
  | FunctionCallItem
  | MessageItem
  | Record<string, unknown>;

export interface ResponsesApiRequest {
  model: string;
  input: unknown;
  previous_response_id?: string;
  reasoning?: {
    effort: "minimal" | "low" | "medium" | "high" | "xhigh";
  };
  tools?: ResponsesToolFunction[];
  max_output_tokens?: number;
}

export interface ResponsesApiResponse {
  id: string;
  status?: string;
  output: ResponseOutputItem[];
  usage?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * Standard workspace repair tool definitions conforming to the Meta Model API Responses API schema.
 */
export const RESPONSES_REPAIR_TOOLS: ResponsesToolFunction[] = [
  {
    type: "function",
    name: "update_file",
    description:
      "Updates or creates a TypeScript/TSX file in the workspace to fix syntax errors. Provide the complete code for the file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path (e.g. App.tsx, components/Button.tsx).",
        },
        code: {
          type: "string",
          description: "The complete, syntactically valid code for the file.",
        },
      },
      required: ["path", "code"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_file",
    description: "Reads the complete code content of an existing workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path to read (e.g. App.tsx).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_syntax_diagnostics",
    description:
      "Evaluates the in-memory workspace and returns any active TypeScript/TSX syntax diagnostics.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

/**
 * Client for Meta Model API Responses API (POST /v1/responses).
 */
export class MetaResponsesClient {
  private config?: MetaResponsesClientConfig;

  constructor(config?: MetaResponsesClientConfig) {
    this.config = config;
  }

  public getResolvedEndpoint(): {
    endpoint: string;
    baseUrl: string;
    apiKey: string | undefined;
  } {
    const explicitKey = (this.config?.apiKey || process.env.MODEL_API_KEY || "").trim();
    const explicitBaseUrl = (
      this.config?.baseUrl ||
      process.env.META_BASE_URL ||
      process.env.MODEL_BASE_URL ||
      ""
    ).trim();
    const baseUrl = (explicitBaseUrl || "https://api.meta.ai/v1").replace(/\/+$/, "");

    return {
      endpoint: `${baseUrl}/responses`,
      baseUrl,
      apiKey: explicitKey || undefined,
    };
  }

  public async sendResponseRequest(
    payload: ResponsesApiRequest
  ): Promise<ResponsesApiResponse> {
    const { endpoint, apiKey } = this.getResolvedEndpoint();

    if (!apiKey) {
      const missingKeyErr = new Error("MODEL_API_KEY is not configured.");
      (missingKeyErr as unknown as { status: number; statusCode: number }).status = 500;
      (missingKeyErr as unknown as { status: number; statusCode: number }).statusCode = 500;
      throw missingKeyErr;
    }

    const fetchFunc = this.config?.fetchFn || fetch;

    let response: Response;
    try {
      response = await fetchFunc(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90000),
      });
    } catch (networkError) {
      const baseMsg =
        networkError instanceof Error ? networkError.message : "Unknown network error";
      const netErr = new Error(
        sanitizeErrorMessage(`Meta Responses API network request failed: ${baseMsg}`)
      );
      (netErr as unknown as { status: number; statusCode: number }).status = 503;
      (netErr as unknown as { status: number; statusCode: number }).statusCode = 503;
      throw netErr;
    }

    if (!response.ok) {
      let errorBody = "";
      try {
        errorBody = await response.text();
      } catch {
        errorBody = "";
      }

      if (response.status === 401) {
        const authErr = new Error(
          "Meta API authentication failed (401). Please check MODEL_API_KEY."
        );
        (authErr as unknown as { status: number; statusCode: number }).status = 401;
        (authErr as unknown as { status: number; statusCode: number }).statusCode = 401;
        throw authErr;
      }
      if (response.status === 429) {
        const rateErr = new Error(
          "Meta API rate limit exceeded (429). Please try again later."
        );
        (rateErr as unknown as { status: number; statusCode: number }).status = 429;
        (rateErr as unknown as { status: number; statusCode: number }).statusCode = 429;
        throw rateErr;
      }

      const statusText = response.statusText ? ` ${response.statusText}` : "";
      const detailMsg = errorBody ? ` Details: ${errorBody}` : "";
      const upstreamErr = new Error(
        sanitizeErrorMessage(
          `Meta Responses API error (${response.status}):${statusText || " Upstream failure"}${detailMsg}`
        )
      );
      (upstreamErr as unknown as { status: number; statusCode: number }).status =
        response.status;
      (upstreamErr as unknown as { status: number; statusCode: number }).statusCode =
        response.status;
      throw upstreamErr;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      const parseErr = new Error("Failed to parse JSON response from Meta Responses API.");
      (parseErr as unknown as { status: number; statusCode: number }).status = 502;
      (parseErr as unknown as { status: number; statusCode: number }).statusCode = 502;
      throw parseErr;
    }

    if (!data || typeof data !== "object") {
      const malformedErr = new Error("Meta Responses API returned an invalid response object.");
      (malformedErr as unknown as { status: number; statusCode: number }).status = 502;
      (malformedErr as unknown as { status: number; statusCode: number }).statusCode = 502;
      throw malformedErr;
    }

    const resObj = data as { id?: unknown; output?: unknown; status?: unknown; usage?: unknown };
    const id = typeof resObj.id === "string" ? resObj.id : "";
    const output = Array.isArray(resObj.output) ? (resObj.output as ResponseOutputItem[]) : [];

    if (!id) {
      const missingIdErr = new Error("Meta Responses API response missing 'id' field.");
      (missingIdErr as unknown as { status: number; statusCode: number }).status = 502;
      (missingIdErr as unknown as { status: number; statusCode: number }).statusCode = 502;
      throw missingIdErr;
    }

    return {
      id,
      status: typeof resObj.status === "string" ? resObj.status : "completed",
      output,
      usage: resObj.usage as ResponsesApiResponse["usage"],
    };
  }
}

export interface ExecuteResponsesRepairOptions {
  model?: string;
  requestId?: string;
  maxIterations?: number;
}

/**
 * Executes a bounded multi-turn repair loop using the Meta Responses API and workspace tools.
 */
export async function executeResponsesRepair(
  workspace: VirtualWorkspace,
  client: MetaResponsesClient,
  options: ExecuteResponsesRepairOptions = {}
): Promise<RepairResult> {
  const maxIterations = Math.min(Math.max(options.maxIterations ?? 3, 1), 3);
  const model = options.model || "muse-spark-1.3";

  let currentDiagnostics = getWorkspaceSyntaxDiagnostics(workspace);

  // Fast-path: If already clean, terminate with 0 attempts and 0 cost
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
  let iteration = 0;
  let previousResponseId: string | undefined = undefined;

  // Turn 1 initial input: describe syntax diagnostics and file list
  const fileSummaries = workspace
    .listFiles()
    .map((f: VirtualFile) => `File: ${f.path}\n\`\`\`\n${f.code}\n\`\`\``)
    .join("\n\n");

  const formattedDiags = currentDiagnostics.map(formatDiagnostic).join("\n");

  let currentInput: unknown = [
    {
      role: "user",
      content: `You are an automated code repair agent. The project currently has TypeScript/TSX syntax errors that must be fixed.

Current Project Files:
${fileSummaries}

TypeScript Compiler Diagnostics:
${formattedDiags}

Task:
Use the available tools (update_file, read_file, get_syntax_diagnostics) to fix the syntax errors while preserving existing functionality and design.`,
    },
  ];

  while (iteration < maxIterations) {
    iteration++;
    const diagnosticsBefore = [...currentDiagnostics];

    let response: ResponsesApiResponse;
    try {
      const requestPayload: ResponsesApiRequest = {
        model,
        input: currentInput,
        tools: RESPONSES_REPAIR_TOOLS,
        reasoning: { effort: "low" },
      };

      if (previousResponseId) {
        requestPayload.previous_response_id = previousResponseId;
      }

      response = await client.sendResponseRequest(requestPayload);
      previousResponseId = response.id;
    } catch (err) {
      return {
        success: false,
        attempts: iteration,
        remainingDiagnostics: currentDiagnostics,
        outcomeReason: `Responses API request error on iteration ${iteration}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        attemptHistory,
        error: err,
      };
    }

    // Inspect function calls in output
    const functionCalls = response.output.filter(
      (item): item is FunctionCallItem =>
        item !== null &&
        typeof item === "object" &&
        (item as { type?: string }).type === "function_call" &&
        typeof (item as { call_id?: unknown }).call_id === "string" &&
        typeof (item as { name?: unknown }).name === "string"
    );

    // If no function calls are returned, the model concluded its turn
    if (functionCalls.length === 0) {
      currentDiagnostics = getWorkspaceSyntaxDiagnostics(workspace);
      if (currentDiagnostics.length === 0) {
        return {
          success: true,
          attempts: iteration,
          remainingDiagnostics: [],
          outcomeReason: `Repaired successfully in ${iteration} iteration${
            iteration > 1 ? "s" : ""
          } via Responses API.`,
          attemptHistory,
        };
      }

      return {
        success: false,
        attempts: iteration,
        remainingDiagnostics: currentDiagnostics,
        outcomeReason: `Model finished response without resolving syntax diagnostics in iteration ${iteration}.`,
        attemptHistory,
      };
    }

    // Execute tool calls safely on VirtualWorkspace
    const toolOutputs: FunctionCallOutputItem[] = [];
    let appliedFileChangesCount = 0;
    let identicalChangesCount = 0;

    for (const fc of functionCalls) {
      let args: Record<string, unknown> = {};
      if (typeof fc.arguments === "string") {
        try {
          args = JSON.parse(fc.arguments);
        } catch {
          toolOutputs.push({
            type: "function_call_output",
            call_id: fc.call_id,
            output: JSON.stringify({
              success: false,
              error: "Malformed JSON arguments in tool call.",
            }),
          });
          continue;
        }
      } else if (fc.arguments && typeof fc.arguments === "object") {
        args = fc.arguments as Record<string, unknown>;
      }

      switch (fc.name) {
        case "update_file": {
          const rawPath = typeof args.path === "string" ? args.path : "";
          const code = typeof args.code === "string" ? args.code : "";

          let normalizedPath: string;
          try {
            normalizedPath = normalizeWorkspacePath(rawPath);
          } catch (pathErr) {
            toolOutputs.push({
              type: "function_call_output",
              call_id: fc.call_id,
              output: JSON.stringify({
                success: false,
                error: pathErr instanceof Error ? pathErr.message : "Invalid path",
              }),
            });
            break;
          }

          // Detect repeated identical changes (stagnation guard)
          if (
            workspace.hasFile(normalizedPath) &&
            workspace.readFile(normalizedPath) === code
          ) {
            identicalChangesCount++;
            toolOutputs.push({
              type: "function_call_output",
              call_id: fc.call_id,
              output: JSON.stringify({
                success: false,
                error: "Proposed code is identical to current file content. No modification made.",
              }),
            });
            break;
          }

          try {
            const operationType = workspace.hasFile(normalizedPath)
              ? "update"
              : "create";
            workspace.applyControlledChanges([
              { type: operationType, path: normalizedPath, code },
            ]);
            appliedFileChangesCount++;

            const diags = getWorkspaceSyntaxDiagnostics(workspace);
            toolOutputs.push({
              type: "function_call_output",
              call_id: fc.call_id,
              output: JSON.stringify({
                success: true,
                path: normalizedPath,
                remainingDiagnosticsCount: diags.length,
                remainingDiagnostics: diags.map(formatDiagnostic),
              }),
            });
          } catch (applyErr) {
            toolOutputs.push({
              type: "function_call_output",
              call_id: fc.call_id,
              output: JSON.stringify({
                success: false,
                error:
                  applyErr instanceof Error
                    ? applyErr.message
                    : "Failed to apply file change.",
              }),
            });
          }
          break;
        }

        case "read_file": {
          const rawPath = typeof args.path === "string" ? args.path : "";
          try {
            const normalizedPath = normalizeWorkspacePath(rawPath);
            if (workspace.hasFile(normalizedPath)) {
              toolOutputs.push({
                type: "function_call_output",
                call_id: fc.call_id,
                output: JSON.stringify({
                  success: true,
                  path: normalizedPath,
                  code: workspace.readFile(normalizedPath),
                }),
              });
            } else {
              toolOutputs.push({
                type: "function_call_output",
                call_id: fc.call_id,
                output: JSON.stringify({
                  success: false,
                  error: `File '${normalizedPath}' does not exist in workspace.`,
                }),
              });
            }
          } catch (pathErr) {
            toolOutputs.push({
              type: "function_call_output",
              call_id: fc.call_id,
              output: JSON.stringify({
                success: false,
                error: pathErr instanceof Error ? pathErr.message : "Invalid path",
              }),
            });
          }
          break;
        }

        case "get_syntax_diagnostics": {
          const diags = getWorkspaceSyntaxDiagnostics(workspace);
          toolOutputs.push({
            type: "function_call_output",
            call_id: fc.call_id,
            output: JSON.stringify({
              diagnosticsCount: diags.length,
              diagnostics: diags.map(formatDiagnostic),
            }),
          });
          break;
        }

        default: {
          toolOutputs.push({
            type: "function_call_output",
            call_id: fc.call_id,
            output: JSON.stringify({
              success: false,
              error: `Unsupported tool name: '${fc.name}'`,
            }),
          });
          break;
        }
      }
    }

    // Re-evaluate diagnostics after tool executions
    currentDiagnostics = getWorkspaceSyntaxDiagnostics(workspace);

    attemptHistory.push({
      attempt: iteration,
      diagnosticsBefore,
      changesApplied: appliedFileChangesCount,
      diagnosticsAfter: currentDiagnostics,
    });

    // Success condition: All syntax errors resolved
    if (currentDiagnostics.length === 0) {
      return {
        success: true,
        attempts: iteration,
        remainingDiagnostics: [],
        outcomeReason: `Repaired successfully in ${iteration} iteration${
          iteration > 1 ? "s" : ""
        } via Responses API.`,
        attemptHistory,
      };
    }

    // Infinite loop & stagnation guard: all file modification tool calls were identical to existing files
    if (
      functionCalls.some((f) => f.name === "update_file") &&
      appliedFileChangesCount === 0 &&
      identicalChangesCount > 0
    ) {
      return {
        success: false,
        attempts: iteration,
        remainingDiagnostics: currentDiagnostics,
        outcomeReason:
          "Repair loop terminated: Repeated identical file changes detected with no diagnostic progress.",
        attemptHistory,
      };
    }

    // Prepare input for next turn with tool outputs
    currentInput = toolOutputs;
  }

  return {
    success: false,
    attempts: iteration,
    remainingDiagnostics: currentDiagnostics,
    outcomeReason: `Repair stopped: Syntax diagnostics remained after maximum ${maxIterations} tool iterations.`,
    attemptHistory,
  };
}
