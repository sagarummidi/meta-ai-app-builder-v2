import { NextResponse } from "next/server";
import ts from "typescript";
import {
  modelRouter,
  AVAILABLE_PROVIDERS,
  getErrorStatusCode,
  sanitizeErrorMessage,
} from "@/lib/modelRouter";
import {
  enforceRouteRateLimit,
  defaultConcurrencyLimiter,
  type IRateLimiter,
  type ConcurrencyLimiter,
} from "@/lib/rateLimiter";

const MAX_INSTRUCTION_LENGTH = 15000;

const responseSchema = {
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
    dependencies: {
      type: "object",
      additionalProperties: { type: "string" },
    },
  },
  required: ["changedFiles"],
};

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

function findSyntaxError(path: string, code: string): string | null {
  const scriptKind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : path.endsWith(".jsx")
    ? ts.ScriptKind.JSX
    : ts.ScriptKind.TS;

  const sourceFile = ts.createSourceFile(
    path,
    code,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );

  const compilerOptions: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
  };

  const host: ts.CompilerHost = {
    getSourceFile: (fileName) =>
      fileName === path ? sourceFile : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => fileName === path,
    readFile: (fileName) => (fileName === path ? code : undefined),
  };

  const program = ts.createProgram([path], compilerOptions, host);
  const diagnostics = program.getSyntacticDiagnostics(sourceFile);

  if (diagnostics.length === 0) {
    return null;
  }

  const first = diagnostics[0];
  const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    first.start ?? 0
  );

  return `${path}:${line + 1}:${character + 1} - ${message}`;
}

function findFirstSyntaxError(
  files: { path: string; code: string }[]
): string | null {
  for (const file of files) {
    if (file && typeof file.path === "string" && typeof file.code === "string") {
      if (file.path.endsWith(".ts") || file.path.endsWith(".tsx")) {
        const error = findSyntaxError(file.path, file.code);

        if (error) {
          return error;
        }
      }
    }
  }

  return null;
}

export async function POST(request: Request, context?: unknown) {
  const serverReqId = Math.random().toString(36).substring(2, 10);
  const startTime = Date.now();

  const injectedRateLimiter = (context as { rateLimiter?: IRateLimiter })?.rateLimiter;
  const injectedConcurrencyLimiter = (context as { concurrencyLimiter?: ConcurrencyLimiter })
    ?.concurrencyLimiter;

  const rateLimitCheck = await enforceRouteRateLimit(request, "edit", {
    limiter: injectedRateLimiter,
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
    const rawInstruction = typeof body?.instruction === "string" ? body.instruction : "";
    const instruction = rawInstruction.trim();
    const currentFiles = Array.isArray(body?.files) ? body.files : [];
    const reqId = typeof body?.requestId === "string" && body.requestId.trim() ? body.requestId.trim() : serverReqId;

    console.log(`[Req ${reqId}] POST /api/edit received instruction length: ${instruction.length}, file count: ${currentFiles.length}`);

    if (!instruction) {
      console.log(`[Req ${reqId}] Rejected edit: empty instruction`);
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: "Please provide an edit instruction.",
        },
        { status: 400 }
      );
    }

    if (instruction.length > MAX_INSTRUCTION_LENGTH) {
      console.log(`[Req ${reqId}] Rejected edit: excessively large instruction (${instruction.length} chars)`);
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: `Edit instruction exceeds maximum allowed length of ${MAX_INSTRUCTION_LENGTH.toLocaleString()} characters.`,
        },
        { status: 400 }
      );
    }

    if (currentFiles.length === 0) {
      console.log(`[Req ${reqId}] Rejected edit: no current files`);
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: "Please provide the current project files.",
        },
        { status: 400 }
      );
    }

    const validCurrentFiles: { name: string; code: string }[] = [];
    for (const f of currentFiles) {
      if (f && typeof f === "object") {
        const name = typeof (f as { name?: string }).name === "string" ? (f as { name: string }).name.trim() : "";
        const code = typeof (f as { code?: string }).code === "string" ? (f as { code: string }).code : "";
        if (name) {
          validCurrentFiles.push({ name, code });
        }
      }
    }

    if (validCurrentFiles.length === 0) {
      console.log(`[Req ${reqId}] Rejected edit: no valid files with names`);
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: "Please provide valid project files.",
        },
        { status: 400 }
      );
    }

    const rawProvider = body.provider || process.env.AI_PROVIDER || "meta";

    const providerConfig = AVAILABLE_PROVIDERS.find((p) => p.provider === rawProvider);
    if (!providerConfig) {
      console.error(`[Req ${reqId}] Error: Provider '${rawProvider}' is not available or registered.`);
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
    const requestedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const modelToUse = requestedModel || providerConfig.models.find((m) => m.isDefault)?.id || providerConfig.models[0]?.id || "";

    const isModelValid = providerConfig.models.some((m) => m.id === modelToUse);
    if (!isModelValid) {
      console.error(`[Req ${reqId}] Error: Model '${modelToUse}' is not available for provider '${providerType}'.`);
      return NextResponse.json(
        {
          success: false,
          requestId: reqId,
          message: `Selected model '${modelToUse}' is not available for provider '${providerType}'.`,
        },
        { status: 400 }
      );
    }

    const filesString = validCurrentFiles.map((f: { name: string; code: string }) => `File: ${f.name}\n\`\`\`\n${f.code}\n\`\`\``).join("\n\n");

    console.log(`[Req ${reqId}] Calling ModelRouter with fallback (${providerType}, model: ${modelToUse}) for edit...`);
    const editStartTime = Date.now();

    const activeConcurrencyLimiter = injectedConcurrencyLimiter || defaultConcurrencyLimiter;
    const fallbackResult = await activeConcurrencyLimiter.execute(() =>
      modelRouter.generateWithFallback(
        {
          model: modelToUse,
          input: `You are an AI code editor.

Here are the current files in the project:
${filesString}

The user wants to make the following edit:
"${instruction}"

Return ONLY valid JSON.

Use exactly this structure for the files that NEED to be changed or added. Do NOT return files that are unmodified.
{
  "changedFiles": [
    {
      "path": "page.tsx", // (use the actual filename from the list above)
      "code": "complete React TypeScript code for the changed file"
    }
  ],
  "dependencies": {}
}

Rules:
- Only return the files that actually need changing based on the instruction.
- If no files need changing, return an empty array for changedFiles.
- Return the ENTIRE complete code for any file that is changed. Do not use snippets or "rest of code here" comments.
- All import paths must be correct.
- dependencies must contain any NEW npm packages added, or existing ones if modified.
- Return ONLY JSON.
- Every regular expression literal (e.g. /[^0-9]/g) must have a matching closing "/" and valid flags.
- Every string, template literal, and regular expression literal must be properly closed.
- Every parenthesis, bracket, and brace must be balanced.
`,
        generationConfig: {
          thinking_level: "low",
        },
        responseFormat: {
          type: "text",
          mime_type: "application/json",
          schema: responseSchema,
        },
        requestId: reqId,
        disableFallback: true,
      },
      providerType
    ));

    const editDuration = Date.now() - editStartTime;
    const response = fallbackResult.response;
    const output = response.outputText;

    console.log(`[Req ${reqId}] Provider ${fallbackResult.usedProvider} edit finished in ${editDuration}ms. Output length: ${output?.length || 0}`);

    if (!output || !output.trim()) {
      throw new Error(`${fallbackResult.usedProvider} returned no output.`);
    }

    const cleanOutput = output
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const start = cleanOutput.indexOf("{");
    const end = cleanOutput.lastIndexOf("}");

    if (start === -1 || end === -1) {
      throw new Error(`${fallbackResult.usedProvider} did not return valid JSON.`);
    }

    const jsonText = cleanOutput.slice(start, end + 1);
    const sanitizedJsonText = sanitizeJsonControlCharacters(jsonText);

    let result;
    try {
      result = JSON.parse(sanitizedJsonText);
    } catch (parseError) {
      console.error(`[Req ${reqId}] JSON.parse failed on ${fallbackResult.usedProvider} output:`, parseError);
      throw new Error(
        `${fallbackResult.usedProvider} returned malformed JSON that could not be parsed, even after sanitization.`
      );
    }

    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(`${fallbackResult.usedProvider} returned invalid JSON structure (expected an object).`);
    }

    if (!result.changedFiles || !Array.isArray(result.changedFiles)) {
      throw new Error(`${fallbackResult.usedProvider} did not return a valid changedFiles array.`);
    }

    const validChangedFiles: { path: string; code: string }[] = [];
    for (const file of result.changedFiles) {
      if (!file || typeof file !== "object") continue;
      const path = typeof file.path === "string" ? file.path.trim() : "";
      const code = typeof file.code === "string" ? file.code : "";
      if (path && code) {
        validChangedFiles.push({ path, code });
      }
    }

    const rawDeps = result.dependencies;
    const dependencies: Record<string, string> = {};
    if (rawDeps && typeof rawDeps === "object" && !Array.isArray(rawDeps)) {
      for (const [key, val] of Object.entries(rawDeps)) {
        if (typeof key === "string" && key.trim()) {
          dependencies[key.trim()] = typeof val === "string" ? val : String(val ?? "latest");
        }
      }
    }

    const syntaxError = findFirstSyntaxError(validChangedFiles);

    if (syntaxError) {
      throw new Error(
        `${fallbackResult.usedProvider} generated invalid TypeScript and it was rejected before reaching the preview (${syntaxError}). Please try editing again.`
      );
    }

    const totalDuration = Date.now() - startTime;
    console.log(`[Req ${reqId}] Edit request successfully completed in ${totalDuration}ms`);

    return NextResponse.json({
      success: true,
      requestId: reqId,
      instruction,
      changedFiles: validChangedFiles,
      dependencies,
      usedModel: fallbackResult.usedModel,
      usedProvider: fallbackResult.usedProvider,
      fallbackUsed: fallbackResult.fallbackUsed,
      fallbackNotice: fallbackResult.fallbackNotice,
    });
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    console.error(`[Req ${serverReqId}] API edit error after ${totalDuration}ms:`, error);

    const statusCode = getErrorStatusCode(error);
    const rawMessage = error instanceof Error ? error.message : "Unknown edit error.";
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
