import ts from "typescript";
import {
  type ModelRouter,
  type ModelProviderType,
  isRetryableModelError,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  sanitizeErrorMessage,
} from "./modelRouter";
import type { GenerationJobStatus } from "./generationJobs";
import { normalizeWorkspacePath } from "./agent/fileOps";
import type { ConcurrencyLimiter } from "./rateLimiter";

export interface GeneratedFile {
  path: string;
  code: string;
}

export interface GenerationOutput {
  files: GeneratedFile[];
  dependencies: Record<string, string>;
}

export interface EditOutput {
  changedFiles: GeneratedFile[];
  dependencies: Record<string, string>;
}

export interface ExtractedJsonResult<T = unknown> {
  success: boolean;
  data?: T;
  rawJson?: string;
  isTruncated: boolean;
  error?: string;
  truncatedPosition?: number;
}

/**
 * Robustly sanitizes control characters inside JSON string literals.
 *
 * Rules:
 * - Unescaped control characters (0x00 - 0x1f) inside string literals are escaped (\n, \r, \t, \uXXXX).
 * - Properly handles escaped backslashes (\\) and escaped quotes (\").
 * - Strips illegal trailing commas before closing braces/brackets outside of strings.
 * - Preserves code strings, template literals, indentation, and quotation marks.
 */
export function sanitizeJsonString(raw: string): string {
  if (!raw || typeof raw !== "string") return "";

  let result = "";
  let insideString = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    const code = raw.charCodeAt(i);

    if (char === '"') {
      let backslashCount = 0;
      for (let j = i - 1; j >= 0 && raw[j] === "\\"; j--) {
        backslashCount++;
      }
      if (backslashCount % 2 === 0) {
        insideString = !insideString;
      }
      result += char;
      continue;
    }

    if (insideString) {
      if (code >= 0x00 && code <= 0x1f) {
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
    } else {
      result += char;
    }
  }

  return stripTrailingCommas(result);
}

/**
 * Strips trailing commas outside string literals.
 */
function stripTrailingCommas(text: string): string {
  let result = "";
  let insideString = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      let backslashCount = 0;
      for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) {
        backslashCount++;
      }
      if (backslashCount % 2 === 0) {
        insideString = !insideString;
      }
      result += char;
      continue;
    }

    if (!insideString && char === ",") {
      let nextNonWhitespaceIndex = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (!/\s/.test(text[j])) {
          nextNonWhitespaceIndex = j;
          break;
        }
      }
      if (
        nextNonWhitespaceIndex !== -1 &&
        (text[nextNonWhitespaceIndex] === "}" || text[nextNonWhitespaceIndex] === "]")
      ) {
        continue;
      }
    }

    result += char;
  }

  return result;
}

/**
 * Normalizes provider finish reasons case-insensitively.
 * Detects token truncation across providers:
 * - "length" and "max_tokens" (OpenAI-compatible, Meta)
 * - "MAX_TOKENS" (Google Gemini)
 */
export function isFinishReasonTruncated(finishReason?: string | null): boolean {
  if (!finishReason || typeof finishReason !== "string") return false;
  const normalized = finishReason.trim().toLowerCase();
  return normalized === "length" || normalized === "max_tokens";
}

/**
 * Extracts JSON content from Markdown code fences or raw text.
 * Prioritizes fences containing the expected application structure when multiple fences exist.
 * Also determines whether the JSON is structurally truncated (unclosed braces, brackets, or strings).
 */
export interface JsonStructureScan {
  firstBraceIndex: number;
  endIndex: number;
  isTruncated: boolean;
  truncatedInString: boolean;
  truncatedPosition: number;
  braceDepth: number;
  bracketDepth: number;
}

/**
 * Robust string-aware scanner that finds root object boundaries and structural truncation.
 */
export function scanJsonStructure(targetText: string): JsonStructureScan {
  const firstBraceIndex = targetText.indexOf("{");
  if (firstBraceIndex === -1) {
    return {
      firstBraceIndex: -1,
      endIndex: -1,
      isTruncated: false,
      truncatedInString: false,
      truncatedPosition: targetText.length,
      braceDepth: 0,
      bracketDepth: 0,
    };
  }

  let insideString = false;
  let braceDepth = 0;
  let bracketDepth = 0;
  let endIndex = -1;

  for (let i = firstBraceIndex; i < targetText.length; i++) {
    const char = targetText[i];

    if (char === '"') {
      let backslashCount = 0;
      for (let j = i - 1; j >= 0 && targetText[j] === "\\"; j--) {
        backslashCount++;
      }
      if (backslashCount % 2 === 0) {
        insideString = !insideString;
      }
      continue;
    }

    if (!insideString) {
      if (char === "{") {
        braceDepth++;
      } else if (char === "}") {
        braceDepth--;
        if (braceDepth === 0) {
          endIndex = i;
          break;
        }
      } else if (char === "[") {
        bracketDepth++;
      } else if (char === "]") {
        bracketDepth--;
      }
    }
  }

  const isTruncated = endIndex === -1 && (insideString || braceDepth > 0 || bracketDepth > 0);

  return {
    firstBraceIndex,
    endIndex,
    isTruncated,
    truncatedInString: insideString,
    truncatedPosition: targetText.length,
    braceDepth,
    bracketDepth,
  };
}

export function extractJsonString(rawOutput: string): {
  extractedText: string;
  isTruncated: boolean;
  fenceFound: boolean;
} {
  if (!rawOutput || typeof rawOutput !== "string") {
    return { extractedText: "", isTruncated: false, fenceFound: false };
  }

  const trimmed = rawOutput.trim();

  // 1. Scan for all Markdown code fences (e.g. ```json ... ```, ```tsx ... ```)
  const fenceRegex = /```([a-zA-Z0-9_-]*)\s*([\s\S]*?)(?:```|$)/g;
  const fences: Array<{ tag: string; content: string; isClosed: boolean }> = [];
  let m: RegExpExecArray | null;

  while ((m = fenceRegex.exec(trimmed)) !== null) {
    const fullMatch = m[0];
    const tag = (m[1] || "").toLowerCase().trim();
    const content = m[2].trim();
    const isClosed = fullMatch.endsWith("```");
    fences.push({ tag, content, isClosed });
  }

  let targetText = trimmed;
  let fenceFound = false;
  let fenceTruncated = false;

  if (fences.length > 0) {
    let chosenFence: { tag: string; content: string; isClosed: boolean } | null = null;

    const hasExpectedKeys = (c: string) =>
      (c.includes('"files"') || c.includes('"changedFiles"')) && c.includes("{");

    // Priority 1: Fence explicitly tagged 'json' containing expected application keys
    for (const f of fences) {
      if (f.tag === "json" && hasExpectedKeys(f.content)) {
        chosenFence = f;
        break;
      }
    }

    // Priority 2: Any fence containing expected application keys and '{'
    if (!chosenFence) {
      for (const f of fences) {
        if (hasExpectedKeys(f.content)) {
          chosenFence = f;
          break;
        }
      }
    }

    // Priority 3: A fence tagged 'json' containing '{'
    if (!chosenFence) {
      for (const f of fences) {
        if (f.tag === "json" && f.content.includes("{")) {
          chosenFence = f;
          break;
        }
      }
    }

    // Priority 4: Generic/unlabeled fence containing a JSON object starting with '{'
    if (!chosenFence) {
      for (const f of fences) {
        const isPureCodeLang = [
          "ts",
          "tsx",
          "typescript",
          "js",
          "jsx",
          "javascript",
          "css",
          "html",
          "sh",
          "bash",
        ].includes(f.tag);
        if (!isPureCodeLang && f.content.trim().startsWith("{")) {
          chosenFence = f;
          break;
        }
      }
    }

    if (chosenFence) {
      fenceFound = true;
      targetText = chosenFence.content;
      fenceTruncated = !chosenFence.isClosed;
    }
  }

  // 2. Scan for root JSON object starting at first '{' using string-aware scanner
  const scan = scanJsonStructure(targetText);
  if (scan.firstBraceIndex === -1) {
    return { extractedText: targetText, isTruncated: fenceTruncated, fenceFound };
  }

  if (scan.endIndex !== -1) {
    return {
      extractedText: targetText.slice(scan.firstBraceIndex, scan.endIndex + 1),
      isTruncated: false,
      fenceFound,
    };
  }

  return {
    extractedText: targetText.slice(scan.firstBraceIndex),
    isTruncated: true,
    fenceFound,
  };
}

/**
 * Checks if a JSON string or parse error indicates truncation.
 */
export function isTruncationError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("unterminated string") ||
    lower.includes("unexpected end of json") ||
    lower.includes("unexpected end of input") ||
    lower.includes("end of data") ||
    lower.includes("truncated")
  );
}

/**
 * Attempts to repair an incomplete / truncated JSON string by closing open strings and containers.
 */
export function repairTruncatedJsonString(incompleteJson: string): string {
  let insideString = false;
  const stack: Array<"{" | "["> = [];

  for (let i = 0; i < incompleteJson.length; i++) {
    const char = incompleteJson[i];

    if (char === '"') {
      let backslashCount = 0;
      for (let j = i - 1; j >= 0 && incompleteJson[j] === "\\"; j--) {
        backslashCount++;
      }
      if (backslashCount % 2 === 0) {
        insideString = !insideString;
      }
      continue;
    }

    if (!insideString) {
      if (char === "{" || char === "[") {
        stack.push(char);
      } else if (char === "}") {
        if (stack.length > 0 && stack[stack.length - 1] === "{") {
          stack.pop();
        }
      } else if (char === "]") {
        if (stack.length > 0 && stack[stack.length - 1] === "[") {
          stack.pop();
        }
      }
    }
  }

  let repaired = incompleteJson;
  if (insideString) {
    // If ending with an odd number of trailing backslashes, escape the backslash first
    let trailingBackslashes = 0;
    for (let j = repaired.length - 1; j >= 0 && repaired[j] === "\\"; j--) {
      trailingBackslashes++;
    }
    if (trailingBackslashes % 2 !== 0) {
      repaired += "\\";
    }
    repaired += '"';
  } else {
    // Strip trailing commas, colons, and whitespace outside strings before closing containers
    repaired = repaired.replace(/[,:\s]+$/, "");
  }

  while (stack.length > 0) {
    const container = stack.pop();
    if (container === "{") {
      repaired += "}";
    } else if (container === "[") {
      repaired += "]";
    }
  }

  return sanitizeJsonString(repaired);
}

/**
 * Robustly parses a JSON string with sanitization and structural recovery.
 */
export function safeParseJson<T = unknown>(rawOutput: string): ExtractedJsonResult<T> {
  const { extractedText, isTruncated: structurallyTruncated } = extractJsonString(rawOutput);

  if (!extractedText) {
    return {
      success: false,
      isTruncated: false,
      error: "No JSON object found in output.",
    };
  }

  const sanitized = sanitizeJsonString(extractedText);

  try {
    const parsed = JSON.parse(sanitized);
    return {
      success: true,
      data: parsed as T,
      rawJson: sanitized,
      isTruncated: false,
    };
  } catch (initialErr) {
    const isTruncated = structurallyTruncated || isTruncationError(initialErr);
    const errMessage = initialErr instanceof Error ? initialErr.message : String(initialErr);
    const posMatch = errMessage.match(/position\s+(\d+)/i);
    const parsePos = posMatch ? parseInt(posMatch[1], 10) : undefined;

    if (!isTruncated) {
      try {
        const repaired = stripTrailingCommas(sanitized);
        const parsed = JSON.parse(repaired);
        return {
          success: true,
          data: parsed as T,
          rawJson: repaired,
          isTruncated: false,
        };
      } catch {
        // Fall through
      }
    }

    try {
      const repaired = repairTruncatedJsonString(sanitized);
      const parsed = JSON.parse(repaired);
      return {
        success: false,
        data: parsed as T,
        rawJson: repaired,
        isTruncated: true,
        error: errMessage,
        truncatedPosition: parsePos ?? sanitized.length,
      };
    } catch {
      return {
        success: false,
        isTruncated,
        error: errMessage,
        truncatedPosition: parsePos ?? sanitized.length,
      };
    }
  }
}

/**
 * Extracts any completely formed files from a truncated JSON output.
 * Preserves already generated files while safely ignoring the cut-off file at the end.
 */
/**
 * Fallback extraction: extracts complete files delivered via Markdown code fences with file headers.
 * (e.g. ```tsx\n// File: App.tsx\n...code...```)
 */
export function extractFilesFromMarkdownFences(rawText: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  if (!rawText || typeof rawText !== "string") return files;

  const fenceRegex = /```([a-zA-Z0-9_-]*)\s*([^\n]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(rawText)) !== null) {
    const tag = (match[1] || "").toLowerCase().trim();
    const meta = (match[2] || "").trim();
    let body = match[3];

    // Skip JSON blocks containing "files" to avoid duplicate parsing
    if (tag === "json" && body.includes('"files"')) {
      continue;
    }

    let detectedPath: string | null = null;
    const metaPathMatch =
      meta.match(/(?:file|filepath|path)\s*[:=]\s*["']?([^"'\s]+)["']?/i) ||
      meta.match(/^["']?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)["']?$/);
    if (metaPathMatch) {
      detectedPath = metaPathMatch[1].trim();
    }

    if (!detectedPath) {
      const lines = body.split("\n", 3);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const commentPathMatch = line.match(
          /^(?:\/\/\s*|\/\*\s*|#\s*)(?:file|filepath|path)\s*[:=]\s*["']?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)["']?(?:\s*\*\/)?/i
        );
        if (commentPathMatch) {
          detectedPath = commentPathMatch[1].trim();
          const allLines = body.split("\n");
          allLines.splice(i, 1);
          body = allLines.join("\n");
          break;
        }
      }
    }

    if (detectedPath && body.trim()) {
      try {
        const normalized = normalizeWorkspacePath(detectedPath);
        if (normalized.endsWith(".ts") || normalized.endsWith(".tsx")) {
          const syntaxError = findSyntaxError(normalized, body);
          if (syntaxError) continue;
        }
        files.push({ path: normalized, code: body });
      } catch {
        // Ignore invalid paths
      }
    }
  }

  return files;
}

/**
 * Extracts any completely formed files from a truncated JSON output.
 * Preserves already generated files while safely ignoring the cut-off file at the end.
 */
export function extractCompleteFilesFromTruncatedJson(rawText: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  if (!rawText || typeof rawText !== "string") return files;

  // 1. Scan for "files" or "changedFiles" array in JSON
  const filesKeyRegex = /"(?:files|changedFiles)"\s*:\s*\[/i;
  const match = rawText.match(filesKeyRegex);

  if (match && match.index !== undefined) {
    const arrayStartIndex = match.index + match[0].length;
    let cursor = arrayStartIndex;

    while (cursor < rawText.length) {
      const nextBrace = rawText.indexOf("{", cursor);
      if (nextBrace === -1) break;

      let insideString = false;
      let braceDepth = 0;
      let objectEnd = -1;

      for (let i = nextBrace; i < rawText.length; i++) {
        const char = rawText[i];

        if (char === '"') {
          let backslashCount = 0;
          for (let j = i - 1; j >= 0 && rawText[j] === "\\"; j--) {
            backslashCount++;
          }
          if (backslashCount % 2 === 0) {
            insideString = !insideString;
          }
          continue;
        }

        if (!insideString) {
          if (char === "{") {
            braceDepth++;
          } else if (char === "}") {
            braceDepth--;
            if (braceDepth === 0) {
              objectEnd = i;
              break;
            }
          }
        }
      }

      if (objectEnd === -1) {
        // The file object was cut off in mid-stream (truncated)
        break;
      }

      const fileJsonSnippet = rawText.slice(nextBrace, objectEnd + 1);
      const sanitizedSnippet = sanitizeJsonString(fileJsonSnippet);

      try {
        const parsedFile = JSON.parse(sanitizedSnippet);
        if (
          parsedFile &&
          typeof parsedFile === "object" &&
          typeof parsedFile.path === "string" &&
          typeof parsedFile.code === "string"
        ) {
          const cleanPath = parsedFile.path.trim();
          const code = parsedFile.code;
          if (cleanPath && code) {
            try {
              const normalized = normalizeWorkspacePath(cleanPath);

              // Validate syntax before marking file as completed
              if (normalized.endsWith(".ts") || normalized.endsWith(".tsx")) {
                const syntaxError = findSyntaxError(normalized, code);
                if (syntaxError) {
                  cursor = objectEnd + 1;
                  continue;
                }
              }

              files.push({ path: normalized, code });
            } catch {
              // Ignore invalid paths
            }
          }
        }
      } catch {
        // Snippet could not be parsed as valid file
      }

      cursor = objectEnd + 1;
    }
  }

  // 2. Fallback to Markdown fences if no complete files recovered from JSON array
  if (files.length === 0) {
    const fencedFiles = extractFilesFromMarkdownFences(rawText);
    if (fencedFiles.length > 0) {
      return fencedFiles;
    }
  }

  return files;
}

/**
 * Detects if the output text contains a file object that was in-flight (partially written)
 * when truncation occurred and was not included in the completely extracted files.
 */
export function findTruncatedFileInOutput(
  rawText: string,
  completedFiles: GeneratedFile[]
): string | null {
  if (!rawText || typeof rawText !== "string") return null;

  const completedPaths = new Set(
    completedFiles.map((f) => {
      try {
        return normalizeWorkspacePath(f.path);
      } catch {
        return f.path.trim();
      }
    })
  );

  const pathRegex = /"path"\s*:\s*"([^"\\]+)"/gi;
  let match: RegExpExecArray | null;
  let lastUnfinishedPath: string | null = null;

  while ((match = pathRegex.exec(rawText)) !== null) {
    const rawPath = match[1].trim();
    try {
      const norm = normalizeWorkspacePath(rawPath);
      if (!completedPaths.has(norm)) {
        lastUnfinishedPath = norm;
      }
    } catch {
      // ignore invalid path
    }
  }

  return lastUnfinishedPath;
}

/**
 * Validates syntax of TypeScript/TSX code using the TypeScript syntactic diagnostic engine.
 */
export function findSyntaxError(path: string, code: string): string | null {
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
    getSourceFile: (fileName) => (fileName === path ? sourceFile : undefined),
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

export function findFirstSyntaxError(files: GeneratedFile[]): string | null {
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

export interface ValidationResult {
  valid: boolean;
  error?: string;
  files?: GeneratedFile[];
  dependencies?: Record<string, string>;
}

/**
 * Validates the complete output structure, file paths, file contents, and syntax.
 */
export function validateGenerationOutput(
  raw: unknown,
  options?: { requireAppFile?: boolean }
): ValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      valid: false,
      error: "Expected JSON response to be an object.",
    };
  }

  const obj = raw as { files?: unknown; dependencies?: unknown };

  if (!obj.files || !Array.isArray(obj.files)) {
    return {
      valid: false,
      error: "Missing or invalid 'files' array in response.",
    };
  }

  if (obj.files.length === 0) {
    return {
      valid: false,
      error: "Response contained an empty project with no files.",
    };
  }

  const validFiles: GeneratedFile[] = [];

  for (let i = 0; i < obj.files.length; i++) {
    const file = obj.files[i];
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      continue;
    }

    const rawPath = typeof (file as { path?: unknown }).path === "string"
      ? (file as { path: string }).path.trim()
      : "";
    const rawCode = typeof (file as { code?: unknown }).code === "string"
      ? (file as { code: string }).code
      : "";

    if (!rawPath) {
      continue;
    }

    // Workspace path security check
    let normalizedPath: string;
    try {
      normalizedPath = normalizeWorkspacePath(rawPath);
    } catch (pathErr) {
      const msg = pathErr instanceof Error ? pathErr.message : String(pathErr);
      return {
        valid: false,
        error: `Security error: File path '${rawPath}' is invalid (${msg}).`,
      };
    }

    if (!rawCode || !rawCode.trim()) {
      return {
        valid: false,
        error: `File '${normalizedPath}' has empty or invalid code content.`,
      };
    }

    validFiles.push({ path: normalizedPath, code: rawCode });
  }

  if (validFiles.length === 0) {
    return {
      valid: false,
      error: "No valid files with code were generated.",
    };
  }

  const dependencies: Record<string, string> = {};
  if (obj.dependencies && typeof obj.dependencies === "object" && !Array.isArray(obj.dependencies)) {
    for (const [key, val] of Object.entries(obj.dependencies)) {
      if (typeof key === "string" && key.trim()) {
        const cleanKey = key.trim();
        if (/^[a-zA-Z0-9@_./-]+$/.test(cleanKey)) {
          dependencies[cleanKey] = typeof val === "string" && val.trim() ? val.trim() : "latest";
        }
      }
    }
  }

  const syntaxError = findFirstSyntaxError(validFiles);
  if (syntaxError) {
    return {
      valid: false,
      error: `Syntactically invalid TypeScript/TSX code: ${syntaxError}`,
      files: validFiles,
      dependencies,
    };
  }

  if (options?.requireAppFile) {
    const hasApp = validFiles.some(
      (f) =>
        f.path === "App.tsx" ||
        f.path.endsWith("/App.tsx") ||
        f.path === "page.tsx" ||
        f.path.endsWith("/page.tsx")
    );
    if (!hasApp) {
      return {
        valid: false,
        error: "Missing required root component (App.tsx or page.tsx).",
        files: validFiles,
        dependencies,
      };
    }
  }

  return {
    valid: true,
    files: validFiles,
    dependencies,
  };
}

export function validateEditOutput(raw: unknown): {
  valid: boolean;
  error?: string;
  changedFiles?: GeneratedFile[];
  dependencies?: Record<string, string>;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      valid: false,
      error: "Expected JSON edit response to be an object.",
    };
  }

  const obj = raw as { changedFiles?: unknown; dependencies?: unknown };

  if (!obj.changedFiles || !Array.isArray(obj.changedFiles)) {
    return {
      valid: false,
      error: "Missing or invalid 'changedFiles' array in edit response.",
    };
  }

  const validFiles: GeneratedFile[] = [];

  for (let i = 0; i < obj.changedFiles.length; i++) {
    const file = obj.changedFiles[i];
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      continue;
    }

    const rawPath = typeof (file as { path?: unknown }).path === "string"
      ? (file as { path: string }).path.trim()
      : "";
    const rawCode = typeof (file as { code?: unknown }).code === "string"
      ? (file as { code: string }).code
      : "";

    if (!rawPath) {
      continue;
    }

    let normalizedPath: string;
    try {
      normalizedPath = normalizeWorkspacePath(rawPath);
    } catch (pathErr) {
      const msg = pathErr instanceof Error ? pathErr.message : String(pathErr);
      return {
        valid: false,
        error: `Security error: Changed file path '${rawPath}' is invalid (${msg}).`,
      };
    }

    if (!rawCode || !rawCode.trim()) {
      return {
        valid: false,
        error: `Changed file '${normalizedPath}' has empty code content.`,
      };
    }

    validFiles.push({ path: normalizedPath, code: rawCode });
  }

  const dependencies: Record<string, string> = {};
  if (obj.dependencies && typeof obj.dependencies === "object" && !Array.isArray(obj.dependencies)) {
    for (const [key, val] of Object.entries(obj.dependencies)) {
      if (typeof key === "string" && key.trim()) {
        const cleanKey = key.trim();
        if (/^[a-zA-Z0-9@_./-]+$/.test(cleanKey)) {
          dependencies[cleanKey] = typeof val === "string" && val.trim() ? val.trim() : "latest";
        }
      }
    }
  }

  const syntaxError = findFirstSyntaxError(validFiles);
  if (syntaxError) {
    return {
      valid: false,
      error: `Syntactically invalid TypeScript/TSX code in edited file: ${syntaxError}`,
    };
  }

  return {
    valid: true,
    changedFiles: validFiles,
    dependencies,
  };
}

/**
 * Merges generated files avoiding duplicates.
 * New files override older versions with the same normalized path.
 */
export function mergeGeneratedFiles(
  baseFiles: GeneratedFile[],
  newFiles: GeneratedFile[]
): GeneratedFile[] {
  const map = new Map<string, GeneratedFile>();

  for (const f of baseFiles) {
    try {
      const norm = normalizeWorkspacePath(f.path);
      map.set(norm, { path: norm, code: f.code });
    } catch {
      // Skip invalid paths
    }
  }

  for (const f of newFiles) {
    try {
      const norm = normalizeWorkspacePath(f.path);
      map.set(norm, { path: norm, code: f.code });
    } catch {
      // Skip invalid paths
    }
  }

  return Array.from(map.values());
}

export interface MissingImportInfo {
  missingPath: string;
  importedBy: string;
  importStatement: string;
}

/**
 * Resolves a relative import path against the current file's directory.
 * e.g. from "App.tsx" with "./components/Card" -> "components/Card"
 * e.g. from "components/Card.tsx" with "../types" -> "types"
 */
export function resolveRelativeImportPath(
  sourceFilePath: string,
  importPath: string
): string | null {
  if (!importPath.startsWith("./") && !importPath.startsWith("../")) {
    return null; // External package
  }

  const lastSlash = sourceFilePath.lastIndexOf("/");
  const sourceDir = lastSlash === -1 ? "" : sourceFilePath.slice(0, lastSlash);
  const combined = sourceDir ? `${sourceDir}/${importPath}` : importPath;

  const segments = combined.split("/");
  const resolvedSegments: string[] = [];

  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (resolvedSegments.length > 0) {
        resolvedSegments.pop();
      }
    } else {
      resolvedSegments.push(seg);
    }
  }

  return resolvedSegments.join("/");
}

/**
 * Checks if a resolved relative import is satisfied by the files in the workspace.
 */
export function isImportPathSatisfied(
  resolvedPath: string,
  existingPaths: Set<string>
): boolean {
  if (existingPaths.has(resolvedPath)) return true;

  const candidateExtensions = [
    ".tsx",
    ".ts",
    ".jsx",
    ".js",
    "/index.tsx",
    "/index.ts",
  ];
  for (const ext of candidateExtensions) {
    if (existingPaths.has(`${resolvedPath}${ext}`)) return true;
  }

  return false;
}

/**
 * Finds all relative imports in the given files that do not exist in the files list.
 * Returns array of missing target paths and the source files that imported them.
 */
export function findMissingLocalImports(
  files: GeneratedFile[]
): MissingImportInfo[] {
  const existingPaths = new Set(
    files.map((f) => {
      try {
        return normalizeWorkspacePath(f.path);
      } catch {
        return f.path.trim();
      }
    })
  );

  const missing: MissingImportInfo[] = [];
  const seenMissing = new Set<string>();

  for (const file of files) {
    if (!/\.[jt]sx?$/.test(file.path)) continue;

    const importRegex =
      /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?from\s+)?['"](\.[^'"]+)['"][^;\n]*;?/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(file.code)) !== null) {
      const statement = match[0].trim();
      const relativePath = match[1];
      const resolved = resolveRelativeImportPath(file.path, relativePath);

      if (resolved && !isImportPathSatisfied(resolved, existingPaths)) {
        const targetPath = /\.[a-zA-Z0-9]+$/.test(resolved)
          ? resolved
          : `${resolved}.tsx`;

        if (!seenMissing.has(targetPath)) {
          seenMissing.add(targetPath);
          missing.push({
            missingPath: targetPath,
            importedBy: file.path,
            importStatement: statement,
          });
        }
      }
    }
  }

  return missing;
}

export interface PipelineTimingInfo {
  totalDurationMs: number;
  initialRequestDurationMs: number;
  continuationDurationMs: number;
  jsonParsingDurationMs: number;
  syntaxValidationDurationMs: number;
  modelCallsCount: number;
  recoveredFilesCount: number;
  finalFilesCount: number;
}

export interface PipelineExecutionOptions {
  modelRouter: ModelRouter;
  provider: ModelProviderType;
  model: string;
  userPrompt: string;
  requestId: string;
  disableFallback?: boolean;
  maxContinuationAttempts?: number;
  concurrencyLimiter?: ConcurrencyLimiter;
  timeoutMs?: number;
  onProgress?: (
    stageMessage: string,
    progressPercent: number,
    completedFiles: GeneratedFile[],
    stageStatus?: GenerationJobStatus
  ) => void;
}

export interface PipelineExecutionResult {
  files: GeneratedFile[];
  dependencies: Record<string, string>;
  usedModel: string;
  usedProvider: ModelProviderType;
  fallbackUsed: boolean;
  fallbackNotice?: string;
  attemptsUsed: number;
  timings: PipelineTimingInfo;
}

/**
 * Executes the generation pipeline with completeness detection,
 * continuation recovery, and workspace validation.
 */
export async function executeGenerationPipeline(
  options: PipelineExecutionOptions
): Promise<PipelineExecutionResult> {
  const {
    modelRouter,
    provider,
    model,
    userPrompt,
    requestId,
    disableFallback,
    maxContinuationAttempts = 2,
    concurrencyLimiter,
    timeoutMs,
    onProgress,
  } = options;

  const startPipelineTime = Date.now();
  const effectiveTimeoutMs = timeoutMs || DEFAULT_PROVIDER_TIMEOUT_MS;
  const pipelineDeadline = startPipelineTime + effectiveTimeoutMs;

  function checkPipelineDeadline(turnDesc: string): void {
    if (Date.now() >= pipelineDeadline) {
      const deadlineErr = new Error(
        `Application generation pipeline exceeded maximum allowed duration (${Math.round(
          effectiveTimeoutMs / 60000
        )} minutes) during ${turnDesc}.`
      );
      (deadlineErr as unknown as { status: number; statusCode: number }).status = 504;
      (deadlineErr as unknown as { status: number; statusCode: number }).statusCode = 504;
      throw deadlineErr;
    }
  }

  let initialRequestDurationMs = 0;
  let continuationDurationMs = 0;
  let jsonParsingDurationMs = 0;
  let syntaxValidationDurationMs = 0;
  let modelCallsCount = 0;

  let accumulatedFiles: GeneratedFile[] = [];
  const accumulatedDeps: Record<string, string> = {};
  let lastUsedModel = model;
  let lastUsedProvider = provider;
  let fallbackUsed = false;
  let fallbackNotice: string | undefined;

  let currentPrompt = `Build a React TypeScript application based on this request:

${userPrompt}

Return ONLY valid JSON.

Use exactly this structure:

{
  "files": [
    {
      "path": "App.tsx",
      "code": "complete React TypeScript code"
    }
  ],
  "dependencies": {}
}

Rules:
- In the "files" array, put App.tsx first, followed by any auxiliary components or types.
- The main file must be App.tsx.
- Use React and TypeScript.
- The app must actually work.
- Make the UI modern and polished.
- Keep the code clean, modular, and focused. Prefer 2 to 5 well-structured files rather than fragmenting into excessively many files.
- Use compact, modern React TypeScript code. Do not write bloated inline SVG coordinates or redundant mockup data (use "lucide-react" for icons if needed).
- Every file must contain complete code. Do not leave any file with incomplete or syntactically invalid code.
- All import paths must be correct.
- Do not use Next.js-specific features.
- dependencies must contain every npm package used by the app.
- Use "latest" for dependency versions.
- Return ONLY JSON.
- Every regular expression literal (e.g. /[^0-9]/g) must have a matching closing "/" and valid flags.
- Every string, template literal, and regular expression literal must be properly closed. Every parenthesis, bracket, and brace must be balanced.
- Every JSX element must have a corresponding closing tag or be self-closing (e.g., <div></div> or <img />).
`;

  let attempt = 0;
  const maxAttempts = 1 + Math.max(0, maxContinuationAttempts);

  while (attempt < maxAttempts) {
    attempt++;
    console.log(
      `[Req ${requestId}] Generation turn ${attempt}/${maxAttempts} (${provider}, model: ${model})...`
    );
    onProgress?.(
      `Generating application components (turn ${attempt}/${maxAttempts})...`,
      Math.min(85, 15 + attempt * 25),
      accumulatedFiles
    );

    checkPipelineDeadline(`turn ${attempt}`);
    const remainingMs = pipelineDeadline - Date.now();
    if (remainingMs <= 0) {
      checkPipelineDeadline(`turn ${attempt}`);
    }
    const callTimeoutMs = Math.min(effectiveTimeoutMs, remainingMs);

    const callStartTime = Date.now();
    modelCallsCount++;

    const modelCallFn = () =>
      modelRouter.generateWithFallback(
        {
          model,
          input: currentPrompt,
          generationConfig: {
            thinking_level: "low",
          },
          responseFormat: {
            type: "text",
            mime_type: "application/json",
          },
          requestId,
          disableFallback,
          timeoutMs: callTimeoutMs,
        },
        provider
      );

    const fallbackResult = concurrencyLimiter
      ? await concurrencyLimiter.execute(modelCallFn)
      : await modelCallFn();

    const callDuration = Date.now() - callStartTime;
    if (attempt === 1) {
      initialRequestDurationMs = callDuration;
    } else {
      continuationDurationMs += callDuration;
    }

    lastUsedModel = fallbackResult.usedModel;
    lastUsedProvider = fallbackResult.usedProvider;
    if (fallbackResult.fallbackUsed) {
      fallbackUsed = true;
      fallbackNotice = fallbackResult.fallbackNotice;
    }

    const response = fallbackResult.response;
    const outputText = response.outputText || "";
    const isProviderTruncated =
      response.truncated === true ||
      isFinishReasonTruncated(response.finishReason);

    console.log(
      `[Req ${requestId}] Received turn ${attempt} response (${callDuration}ms, length: ${
        outputText.length
      }, finishReason: ${
        response.finishReason || "none"
      }, providerTruncated: ${isProviderTruncated})`
    );

    if (!outputText || !outputText.trim()) {
      throw new Error(`${lastUsedProvider} returned no output.`);
    }

    // 1. Parse JSON output
    const parseStartTime = Date.now();
    const parseResult = safeParseJson<GenerationOutput>(outputText);
    jsonParsingDurationMs += Date.now() - parseStartTime;

    const isTruncated = isProviderTruncated || parseResult.isTruncated;

    logGenerationStageDiagnostic({
      requestId,
      provider: lastUsedProvider,
      model: lastUsedModel,
      stage: `pipeline_turn_${attempt}`,
      attempt,
      responseLength: outputText.length,
      finishReason: response.finishReason || undefined,
      isTruncated,
      jsonParseError: parseResult.error,
      recoveredFilesCount: accumulatedFiles.length,
      jobStatus: "generating",
    });

    // Fast path: if JSON parsed successfully without structural truncation
    if (!isTruncated && parseResult.success && parseResult.data) {
      const valStartTime = Date.now();
      const validation = validateGenerationOutput(parseResult.data);
      syntaxValidationDurationMs += Date.now() - valStartTime;

      if (validation.valid && validation.files) {
        const mergedFiles = mergeGeneratedFiles(
          accumulatedFiles,
          validation.files
        );
        const mergedDeps = { ...accumulatedDeps, ...validation.dependencies };

        // Check if there are any missing relative imports in the merged project
        const missingImports = findMissingLocalImports(mergedFiles);

        if (missingImports.length === 0) {
          const finalValStartTime = Date.now();
          const finalSyntaxErr = findFirstSyntaxError(mergedFiles);
          syntaxValidationDurationMs += Date.now() - finalValStartTime;

          if (finalSyntaxErr) {
            throw new Error(
              `${lastUsedProvider} generated invalid TypeScript (${finalSyntaxErr}).`
            );
          }

          const totalDurationMs = Date.now() - startPipelineTime;
          const timings: PipelineTimingInfo = {
            totalDurationMs,
            initialRequestDurationMs,
            continuationDurationMs,
            jsonParsingDurationMs,
            syntaxValidationDurationMs,
            modelCallsCount,
            recoveredFilesCount: accumulatedFiles.length,
            finalFilesCount: mergedFiles.length,
          };

          console.log(
            `[Req ${requestId}] Generation successfully validated on attempt ${attempt} (${
              mergedFiles.length
            } files, total=${totalDurationMs}ms, calls=${modelCallsCount}).`
          );

          return {
            files: mergedFiles,
            dependencies: mergedDeps,
            usedModel: lastUsedModel,
            usedProvider: lastUsedProvider,
            fallbackUsed,
            fallbackNotice,
            attemptsUsed: attempt,
            timings,
          };
        } else {
          accumulatedFiles = mergedFiles;
          Object.assign(accumulatedDeps, mergedDeps);
          console.log(
            `[Req ${requestId}] Notice: Generated code references missing local imports: ${missingImports
              .map((m) => m.missingPath)
              .join(", ")}. Continuing generation for missing files...`
          );
        }
      } else if (
        !validation.valid &&
        validation.error &&
        !validation.error.includes("Syntactically invalid")
      ) {
        if (attempt >= maxAttempts) {
          throw new Error(
            `${lastUsedProvider} output validation failed: ${validation.error}`
          );
        }
      }
    }

    // 2. Recovery path: extract completed files from partial / truncated JSON
    const recoveryStartTime = Date.now();
    const completedFilesFromSnippet =
      extractCompleteFilesFromTruncatedJson(outputText);
    jsonParsingDurationMs += Date.now() - recoveryStartTime;

    if (completedFilesFromSnippet.length > 0) {
      accumulatedFiles = mergeGeneratedFiles(
        accumulatedFiles,
        completedFilesFromSnippet
      );
      console.log(
        `[Req ${requestId}] Recovered ${
          completedFilesFromSnippet.length
        } complete files from response: ${completedFilesFromSnippet
          .map((f) => f.path)
          .join(", ")}`
      );

      // Check if accumulated files ALREADY form a complete working app
      const hasMain = accumulatedFiles.some(
        (f) =>
          f.path === "App.tsx" ||
          f.path.endsWith("/App.tsx") ||
          f.path === "page.tsx" ||
          f.path.endsWith("/page.tsx")
      );

      const cutOffFilePath = findTruncatedFileInOutput(
        outputText,
        accumulatedFiles
      );
      const missingImports = findMissingLocalImports(accumulatedFiles);

      if (hasMain && !cutOffFilePath && missingImports.length === 0) {
        const valStartTime = Date.now();
        const syntaxErr = findFirstSyntaxError(accumulatedFiles);
        syntaxValidationDurationMs += Date.now() - valStartTime;

        if (!syntaxErr) {
          const totalDurationMs = Date.now() - startPipelineTime;
          const timings: PipelineTimingInfo = {
            totalDurationMs,
            initialRequestDurationMs,
            continuationDurationMs,
            jsonParsingDurationMs,
            syntaxValidationDurationMs,
            modelCallsCount,
            recoveredFilesCount: accumulatedFiles.length,
            finalFilesCount: accumulatedFiles.length,
          };

          console.log(
            `[Req ${requestId}] Recovered files already constitute a complete valid application (${
              accumulatedFiles.length
            } files). Skipping unnecessary continuation.`
          );

          return {
            files: accumulatedFiles,
            dependencies: accumulatedDeps,
            usedModel: lastUsedModel,
            usedProvider: lastUsedProvider,
            fallbackUsed,
            fallbackNotice,
            attemptsUsed: attempt,
            timings,
          };
        }
      }
    }

    if (attempt >= maxAttempts) {
      if (isTruncated) {
        throw new Error(
          `${lastUsedProvider} response was truncated due to output token limits and could not be recovered after ${maxAttempts} attempts. Please use a more specific or concise prompt.`
        );
      } else {
        const detail = parseResult.error ? ` (${parseResult.error})` : "";
        throw new Error(
          `${lastUsedProvider} returned malformed JSON that could not be parsed, even after sanitization${detail}.`
        );
      }
    }

    // 3. Build targeted continuation request
    if (accumulatedFiles.length > 0) {
      const completedList = accumulatedFiles.map((f) => `- ${f.path}`).join("\n");
      const missingImports = findMissingLocalImports(accumulatedFiles);
      const cutOffFilePath = findTruncatedFileInOutput(
        outputText,
        accumulatedFiles
      );

      const missingSet = new Set<string>();
      if (cutOffFilePath) {
        missingSet.add(cutOffFilePath);
      }
      for (const m of missingImports) {
        missingSet.add(m.missingPath);
      }

      const missingArray = Array.from(missingSet);
      // Prioritize at most 2 missing files at a time to prevent output token limit exhaustion
      const targetMissing = missingArray.slice(0, 2);
      const missingList =
        targetMissing.length > 0
          ? targetMissing.map((p) => `- ${p}`).join("\n")
          : "- App.tsx";

      const importContext =
        missingImports.length > 0
          ? "\nRelevant import statements in existing code:\n" +
            missingImports
              .map((m) => `  ${m.importStatement} in ${m.importedBy}`)
              .join("\n")
          : "";

      currentPrompt = `The previous response was truncated due to output token limits.

Already generated and saved files:
${completedList}

Missing required files that must be generated:
${missingList}
${importContext}

Task:
Continue building the application: "${userPrompt}"
Provide ONLY the missing files listed above and any dependencies.
Do NOT repeat, rewrite, or regenerate the already completed files listed above.
Every returned file must be complete, working React TypeScript code matching the expected imports.

Return ONLY valid JSON matching:
{
  "files": [
    {
      "path": "path/to/missingFile.tsx",
      "code": "complete code"
    }
  ],
  "dependencies": {}
}
`;
    } else {
      // No complete files recovered in first turn
      currentPrompt = `The previous response was cut off due to output token limits while generating App.tsx.

Task:
Build the requested React TypeScript application: "${userPrompt}"
Keep the code clean, modular, and focused so that all files fit comfortably within output token limits.
The main file must be App.tsx. Every file must contain complete, working code.

Return ONLY valid JSON:
{
  "files": [
    {
      "path": "App.tsx",
      "code": "complete code"
    }
  ],
  "dependencies": {}
}
`;
    }
  }

  logGenerationStageDiagnostic({
    requestId,
    provider: lastUsedProvider,
    model: lastUsedModel,
    stage: "pipeline_exhausted",
    attempt,
    recoveredFilesCount: accumulatedFiles.length,
    jobStatus: "failed",
  });

  const failureErr = new Error(
    `${lastUsedProvider} failed to generate a complete application after ${attempt} attempts.`
  );
  (failureErr as unknown as { status: number; statusCode: number }).status = 502;
  (failureErr as unknown as { status: number; statusCode: number }).statusCode = 502;
  throw failureErr;
}

export interface PlannedFile {
  path: string;
  purpose: string;
}

export interface ApplicationPlan {
  plan: string;
  files: PlannedFile[];
  dependencies: Record<string, string>;
}

export interface StageDiagnosticLog {
  requestId: string;
  jobId?: string;
  provider: string;
  model: string;
  stage: string;
  filePath?: string;
  attempt?: number;
  responseLength?: number;
  finishReason?: string;
  isTruncated?: boolean;
  jsonParseError?: string;
  jsonParsePosition?: number;
  recoveredFilesCount?: number;
  incompleteFiles?: string[];
  jobStatus?: string;
}

export function logGenerationStageDiagnostic(info: StageDiagnosticLog): void {
  const safeLog: StageDiagnosticLog = {
    ...info,
    jsonParseError: info.jsonParseError ? sanitizeErrorMessage(info.jsonParseError) : undefined,
  };
  console.log(`[GenDiag] ${JSON.stringify(safeLog)}`);
}

/**
 * Extracts a compact, structured representation of user requirements from a prompt.
 * Preserves essential functional requirements, user flows, and state across the ENTIRE prompt
 * (including requirements located near the end of long prompts) while removing verbose
 * system instructions, meta-boilerplate, and redundant styling prose.
 */
export function extractCompactRequirements(userPrompt: string): string {
  if (!userPrompt || typeof userPrompt !== "string") {
    return "Build a modular React TypeScript application.";
  }

  const trimmed = userPrompt.trim();
  if (trimmed.length <= 600) {
    return trimmed;
  }

  const lines = trimmed.split(/\r?\n/);
  const primaryGoalLines: string[] = [];
  const requirementItems: string[] = [];
  const seenItems = new Set<string>();

  const isBoilerplate = (line: string): boolean => {
    return /(?:return only valid json|valid json schema|typescript error|do not include markdown|expert (?:software|react) (?:engineer|developer)|clean code best practices|do not output explanatory text)/i.test(
      line
    );
  };

  const isRequirementCue = (text: string): boolean => {
    return /(?:must|should|shall|need|needs to|require|required|feature|support|allow|enable|user can|ensure|provide|include|implement|add|track|manage|calculate|export|import|toggle|button|modal|filter|search|sort|view|chart|table|form|goal|budget|persist|store|theme|dark mode|state|action)/i.test(
      text
    );
  };

  let inRequirementsSection = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine) continue;

    if (isBoilerplate(rawLine)) continue;

    // Check for section headers
    if (/^(?:#+\s*|\*\*)?(?:features|requirements|specifications|functionality|capabilities|user stories|core features|data management|settings|storage)/i.test(rawLine)) {
      inRequirementsSection = true;
      continue;
    }

    // Capture opening 1-2 lines as primary goal
    if (primaryGoalLines.length < 2 && !inRequirementsSection && !/^[-*•\d+.]/.test(rawLine)) {
      primaryGoalLines.push(rawLine);
      continue;
    }

    // Check for bullet points or numbered list items
    const listMatch = rawLine.match(/^(?:[-*•]|\d+[.)]|\[[ xX]\])\s*(.+)$/);
    if (listMatch) {
      const itemText = listMatch[1].trim();
      const normKey = itemText.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (itemText && !isBoilerplate(itemText) && !seenItems.has(normKey)) {
        seenItems.add(normKey);
        requirementItems.push(itemText);
      }
      continue;
    }

    // If inside a requirements section or line has strong requirement cues
    if ((inRequirementsSection || isRequirementCue(rawLine)) && rawLine.length > 15) {
      const normKey = rawLine.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!seenItems.has(normKey)) {
        seenItems.add(normKey);
        requirementItems.push(rawLine);
      }
    }
  }

  // If no list items or section items found, extract requirement sentences across the prompt
  if (requirementItems.length === 0) {
    const sentences = trimmed.split(/(?<=[.!?])\s+/);
    for (const sent of sentences) {
      const cleanSent = sent.trim();
      if (cleanSent.length > 20 && isRequirementCue(cleanSent) && !isBoilerplate(cleanSent)) {
        const normKey = cleanSent.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!seenItems.has(normKey)) {
          seenItems.add(normKey);
          requirementItems.push(cleanSent);
        }
      }
    }
  }

  const goalText = primaryGoalLines.join(" ").trim() || trimmed.slice(0, 300);

  if (requirementItems.length === 0) {
    return trimmed.length > 1500 ? trimmed.slice(0, 1500) + "..." : trimmed;
  }

  const formattedItems = requirementItems.map((item) => `- ${item}`).join("\n");
  return `Primary Application Goal:
${goalText}

Essential Features & Requirements:
${formattedItems}`;
}

export interface StagedPipelineOptions {
  modelRouter: ModelRouter;
  provider: ModelProviderType;
  model: string;
  userPrompt: string;
  requestId: string;
  disableFallback?: boolean;
  concurrencyLimiter?: ConcurrencyLimiter;
  timeoutMs?: number;
  onProgress?: (
    stageMessage: string,
    progressPercent: number,
    completedFiles: GeneratedFile[],
    stageStatus?: GenerationJobStatus
  ) => void;
  maxComponentRetries?: number;
}

/**
 * Executes a controlled staged generation pipeline for multi-file applications:
 * 1. Plan application architecture and file manifest (compact call, ~200-400 tokens)
 * 2. Generate shared types, models and configurations
 * 3. Generate individual components one-by-one with type context (small bounded calls)
 * 4. Generate the main application entry point (App.tsx)
 * 5. Validate TypeScript syntax and resolve relative imports
 * 6. Target repair for any missing or broken local files
 */
export async function executeStagedGenerationPipeline(
  options: StagedPipelineOptions
): Promise<PipelineExecutionResult> {
  const {
    modelRouter,
    provider,
    model,
    userPrompt,
    requestId,
    disableFallback,
    concurrencyLimiter,
    timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
    onProgress,
    maxComponentRetries = 1,
  } = options;

  const startPipelineTime = Date.now();
  const pipelineDeadline = startPipelineTime + timeoutMs; // overall pipeline deadline (default 10 minutes)
  let initialRequestDurationMs = 0;
  let continuationDurationMs = 0;
  let jsonParsingDurationMs = 0;
  let syntaxValidationDurationMs = 0;
  let modelCallsCount = 0;

  let accumulatedFiles: GeneratedFile[] = [];
  const accumulatedDeps: Record<string, string> = {};
  let lastUsedModel = model;
  let lastUsedProvider = provider;
  let fallbackUsed = false;
  let fallbackNotice: string | undefined;

  function checkPipelineDeadline(stageName: string): void {
    if (Date.now() >= pipelineDeadline) {
      const deadlineErr = new Error(
        `Application generation pipeline exceeded maximum allowed duration (${Math.round(timeoutMs / 60000)} minutes) during stage '${stageName}'.`
      );
      (deadlineErr as unknown as { status: number; statusCode: number }).status = 504;
      (deadlineErr as unknown as { status: number; statusCode: number }).statusCode = 504;
      throw deadlineErr;
    }
  }

  async function invokeModel(promptText: string, stageName: string): Promise<string> {
    checkPipelineDeadline(stageName);
    const callStartTime = Date.now();
    const remainingMs = pipelineDeadline - Date.now();
    if (remainingMs <= 0) {
      checkPipelineDeadline(stageName);
    }

    modelCallsCount++;
    const callTimeoutMs = Math.min(timeoutMs, remainingMs);

    const modelCallFn = () =>
      modelRouter.generateWithFallback(
        {
          model,
          input: promptText,
          generationConfig: {
            thinking_level: "low",
          },
          responseFormat: {
            type: "text",
            mime_type: "application/json",
          },
          requestId,
          disableFallback,
          timeoutMs: callTimeoutMs,
        },
        provider
      );

    const result = concurrencyLimiter
      ? await concurrencyLimiter.execute(modelCallFn)
      : await modelCallFn();

    const callDuration = Date.now() - callStartTime;
    if (modelCallsCount === 1) {
      initialRequestDurationMs = callDuration;
    } else {
      continuationDurationMs += callDuration;
    }

    lastUsedModel = result.usedModel;
    lastUsedProvider = result.usedProvider;
    if (result.fallbackUsed) {
      fallbackUsed = true;
      fallbackNotice = result.fallbackNotice;
    }

    const output = result.response.outputText || "";
    if (!output || !output.trim()) {
      const emptyErr = new Error(`${lastUsedProvider} returned an empty completion during stage '${stageName}'.`);
      (emptyErr as unknown as { status: number; statusCode: number }).status = 502;
      (emptyErr as unknown as { status: number; statusCode: number }).statusCode = 502;
      throw emptyErr;
    }
    return output;
  }

  // --- STAGE 1: PLAN APPLICATION ARCHITECTURE ---
  onProgress?.("Planning application architecture...", 10, accumulatedFiles, "planning");

  const planPrompt = `Plan a React TypeScript application based on this request:
"${userPrompt}"

Provide a clean, focused, modular architectural plan with 2 to 5 files:
1. "types.ts" (if domain models or interfaces are needed)
2. 1 to 3 focused component files (e.g. "components/ExpenseForm.tsx", "components/ExpenseList.tsx")
3. "App.tsx" (the main root application component that imports and connects them)

Keep the plan clean, realistic, and modular. Do not over-engineer with too many files.

Return ONLY valid JSON matching this schema:
{
  "plan": "Short description of the app design",
  "files": [
    { "path": "types.ts", "purpose": "Type definitions for data models" },
    { "path": "components/ExpenseForm.tsx", "purpose": "Form to add items" },
    { "path": "App.tsx", "purpose": "Main application layout and state" }
  ],
  "dependencies": {
    "lucide-react": "latest"
  }
}`;

  let plannedFiles: PlannedFile[] = [];

  try {
    const planOutput = await invokeModel(planPrompt, "planning");
    const parseStart = Date.now();
    const parsedPlan = safeParseJson<ApplicationPlan>(planOutput);
    jsonParsingDurationMs += Date.now() - parseStart;

    logGenerationStageDiagnostic({
      requestId,
      provider: lastUsedProvider,
      model: lastUsedModel,
      stage: "planning",
      attempt: 1,
      responseLength: planOutput.length,
      isTruncated: parsedPlan.isTruncated,
      jsonParseError: parsedPlan.error,
      jsonParsePosition: parsedPlan.truncatedPosition,
      recoveredFilesCount: 0,
      jobStatus: "planning",
    });

    if (parsedPlan.success && parsedPlan.data?.files && Array.isArray(parsedPlan.data.files)) {
      for (const item of parsedPlan.data.files) {
        if (!item || typeof item.path !== "string") continue;
        try {
          const norm = normalizeWorkspacePath(item.path);
          plannedFiles.push({
            path: norm,
            purpose: typeof item.purpose === "string" ? item.purpose : "Component",
          });
        } catch {
          // ignore invalid path
        }
      }

      if (parsedPlan.data.dependencies && typeof parsedPlan.data.dependencies === "object") {
        for (const [k, v] of Object.entries(parsedPlan.data.dependencies)) {
          if (typeof k === "string" && /^[a-zA-Z0-9@_./-]+$/.test(k.trim())) {
            accumulatedDeps[k.trim()] = typeof v === "string" ? v : "latest";
          }
        }
      }
    }
  } catch (planErr) {
    if (!isRetryableModelError(planErr)) {
      throw planErr;
    }
    console.warn(`[Req ${requestId}] Plan model call failed, falling back to default plan:`, planErr);
  }

  // Ensure App.tsx exists in planned files
  const hasAppInPlan = plannedFiles.some(
    (f) => f.path === "App.tsx" || f.path.endsWith("/App.tsx")
  );
  if (!hasAppInPlan) {
    plannedFiles.push({
      path: "App.tsx",
      purpose: "Main root application entry point",
    });
  }

  // Deduplicate and cap at 5 files
  const seenPaths = new Set<string>();
  const uniquePlanned: PlannedFile[] = [];
  for (const pf of plannedFiles) {
    if (!seenPaths.has(pf.path)) {
      seenPaths.add(pf.path);
      uniquePlanned.push(pf);
    }
  }
  plannedFiles = uniquePlanned.slice(0, 5);

  // Group files: shared (types, utils, config), components, and entry point (App.tsx)
  const sharedFiles = plannedFiles.filter(
    (f) =>
      f.path !== "App.tsx" &&
      (f.path === "types.ts" ||
        f.path.includes("types") ||
        f.path.includes("util") ||
        f.path.includes("config"))
  );

  const componentFiles = plannedFiles.filter(
    (f) =>
      f.path !== "App.tsx" &&
      !sharedFiles.some((sf) => sf.path === f.path)
  );

  checkPipelineDeadline("planning");

  // --- STAGE 2: GENERATE SHARED TYPES & UTILITIES ---
  for (let i = 0; i < sharedFiles.length; i++) {
    checkPipelineDeadline("generating_shared");
    const file = sharedFiles[i];
    const progress = 20 + Math.round(((i + 1) / (sharedFiles.length + 1)) * 15);
    onProgress?.(`Generating shared file: ${file.path}...`, progress, accumulatedFiles, "generating_shared");

    const sharedPrompt = `Generate the following shared file for the React TypeScript application "${userPrompt}":
Path: "${file.path}"
Purpose: "${file.purpose}"

Return ONLY valid JSON:
{
  "files": [
    {
      "path": "${file.path}",
      "code": "complete TypeScript code"
    }
  ],
  "dependencies": {}
}`;

    try {
      const output = await invokeModel(sharedPrompt, "generating_shared");
      const parseStart = Date.now();
      const parsed = safeParseJson<GenerationOutput>(output);
      jsonParsingDurationMs += Date.now() - parseStart;

      logGenerationStageDiagnostic({
        requestId,
        provider: lastUsedProvider,
        model: lastUsedModel,
        stage: "generating_shared",
        filePath: file.path,
        attempt: 1,
        responseLength: output.length,
        isTruncated: parsed.isTruncated,
        jsonParseError: parsed.error,
        jsonParsePosition: parsed.truncatedPosition,
        recoveredFilesCount: accumulatedFiles.length,
        jobStatus: "generating_shared",
      });

      if (parsed.success && parsed.data?.files) {
        const valStart = Date.now();
        const validated = validateGenerationOutput(parsed.data);
        syntaxValidationDurationMs += Date.now() - valStart;

        if (validated.valid && validated.files && validated.files.length > 0) {
          accumulatedFiles = mergeGeneratedFiles(accumulatedFiles, validated.files);
          if (validated.dependencies) {
            Object.assign(accumulatedDeps, validated.dependencies);
          }
        }
      } else {
        const recovered = extractCompleteFilesFromTruncatedJson(output);
        const fileRecovered = recovered.find((f) => f.path === file.path);
        if (fileRecovered) {
          accumulatedFiles = mergeGeneratedFiles(accumulatedFiles, [fileRecovered]);
        }
      }
    } catch (sharedErr) {
      console.warn(`[Req ${requestId}] Failed to generate shared file ${file.path}:`, sharedErr);
    }
  }

  checkPipelineDeadline("generating_shared");

  // --- STAGE 3: GENERATE INDIVIDUAL COMPONENTS ---
  const sharedContext = accumulatedFiles
    .filter((f) => f.path.endsWith(".ts"))
    .map((f) => `// File: ${f.path}\n${f.code}`)
    .join("\n\n");

  for (let i = 0; i < componentFiles.length; i++) {
    checkPipelineDeadline("generating_components");
    const comp = componentFiles[i];
    const progress = 35 + Math.round(((i + 1) / (componentFiles.length + 1)) * 40);
    onProgress?.(`Generating component: ${comp.path}...`, progress, accumulatedFiles, "generating_components");

    let compPrompt = `Generate the component "${comp.path}" for the application "${userPrompt}".
Purpose: "${comp.purpose}"

${sharedContext ? `Existing types and shared interfaces in the project:\n${sharedContext}\n` : ""}
Rules:
- Export the component cleanly.
- Use React and TypeScript.
- The component must actually work and have complete, functional code.
- Keep the code concise, modular, and modern (e.g. use "lucide-react" for icons).
- Return ONLY valid JSON:
{
  "files": [
    {
      "path": "${comp.path}",
      "code": "complete React component code"
    }
  ],
  "dependencies": {}
}`;

    let compSuccess = false;
    let retries = 0;

    while (!compSuccess && retries <= maxComponentRetries) {
      checkPipelineDeadline("generating_components");
      try {
        const output = await invokeModel(compPrompt, "generating_components");
        const parseStart = Date.now();
        const parsed = safeParseJson<GenerationOutput>(output);
        jsonParsingDurationMs += Date.now() - parseStart;

        logGenerationStageDiagnostic({
          requestId,
          provider: lastUsedProvider,
          model: lastUsedModel,
          stage: "generating_components",
          filePath: comp.path,
          attempt: retries + 1,
          responseLength: output.length,
          isTruncated: parsed.isTruncated,
          jsonParseError: parsed.error,
          jsonParsePosition: parsed.truncatedPosition,
          recoveredFilesCount: accumulatedFiles.length,
          jobStatus: "generating_components",
        });

        if (parsed.success && parsed.data?.files) {
          const valStart = Date.now();
          const validated = validateGenerationOutput(parsed.data);
          syntaxValidationDurationMs += Date.now() - valStart;

          if (validated.valid && validated.files && validated.files.length > 0) {
            accumulatedFiles = mergeGeneratedFiles(accumulatedFiles, validated.files);
            if (validated.dependencies) {
              Object.assign(accumulatedDeps, validated.dependencies);
            }
            compSuccess = true;
          }
        }

        if (!compSuccess) {
          // Check if partial file extraction works
          const recovered = extractCompleteFilesFromTruncatedJson(output);
          const compRecovered = recovered.find((f) => f.path === comp.path);
          if (compRecovered) {
            accumulatedFiles = mergeGeneratedFiles(accumulatedFiles, [compRecovered]);
            compSuccess = true;
          }
        }
      } catch (err) {
        console.warn(`[Req ${requestId}] Attempt ${retries + 1} for ${comp.path} failed:`, err);
        if (!isRetryableModelError(err)) {
          break;
        }
      }

      if (!compSuccess) {
        retries++;
        compPrompt = `The previous attempt for "${comp.path}" was truncated or invalid.
Generate a concise, clean, working implementation of "${comp.path}" for "${userPrompt}".
Keep code compact to ensure it stays well within output token limits.
Return ONLY valid JSON:
{
  "files": [
    {
      "path": "${comp.path}",
      "code": "complete React component code"
    }
  ],
  "dependencies": {}
}`;
      }
    }
  }

  checkPipelineDeadline("generating_components");

  // --- STAGE 4: GENERATE MAIN APPLICATION ENTRY POINT (App.tsx) ---
  onProgress?.("Generating main application entry point (App.tsx)...", 80, accumulatedFiles, "generating_entry");

  const availableFilesSummary = accumulatedFiles
    .filter((f) => f.path !== "App.tsx")
    .map((f) => `- ${f.path}`)
    .join("\n");

  const typesFile = accumulatedFiles.find((f) => f.path === "types.ts");
  const typesSummary =
    typesFile && typesFile.code.length < 2500
      ? `\nType definitions:\n${typesFile.code}\n`
      : "";

  const compactReqs = extractCompactRequirements(userPrompt);

  const baseAppPrompt = `Generate the main application file "App.tsx" that coordinates the application:

${compactReqs}

Existing components already created in the project:
${availableFilesSummary || "- (Single file application)"}
${typesSummary}
Rules:
- The main file must be App.tsx with default export: export default function App().
- Import and connect the available components cleanly.
- Do NOT re-implement or duplicate the logic of existing components. App.tsx is the orchestrator.
- Manage root application state and user interactions cleanly.
- Connect all required features, actions, and user controls in App.tsx.
- Keep App.tsx concise (under 120-150 lines) so it stays well within output token limits.
- Use React and TypeScript.
- Return ONLY valid JSON:
{
  "files": [
    {
      "path": "App.tsx",
      "code": "complete React TypeScript code"
    }
  ],
  "dependencies": {}
}`;

  let currentAppPrompt = baseAppPrompt;
  let appGenerated = false;
  let appRetries = 0;
  let lastAppError = "";
  let lastAppStatusCode = 502;
  const maxAppRetries = typeof maxComponentRetries === "number" && maxComponentRetries >= 0 ? maxComponentRetries : 1;

  while (!appGenerated && appRetries <= maxAppRetries) {
    checkPipelineDeadline("generating_entry");

    if (appRetries > 0) {
      await new Promise((resolve) => setTimeout(resolve, 300 * appRetries));

      currentAppPrompt = `The previous attempt for App.tsx was truncated or incomplete.
Generate a clean, compact "App.tsx" orchestrator that connects the application components according to these requirements:

${compactReqs}

Existing components already created in the project (do not duplicate their logic):
${availableFilesSummary || "- None"}
${typesSummary}
Rules:
- Default export: export default function App()
- Import and assemble available components. Do not rewrite their internal logic.
- Coordinate the required features, root state, and user interactions cleanly.
- Keep the implementation clean, functional, and compact (under 120-150 lines) to avoid truncation.
- Return ONLY valid JSON:
{
  "files": [
    {
      "path": "App.tsx",
      "code": "complete React TypeScript code"
    }
  ],
  "dependencies": {}
}`;
    }

    try {
      const output = await invokeModel(currentAppPrompt, "generating_entry");
      const parseStart = Date.now();
      const parsed = safeParseJson<GenerationOutput>(output);
      jsonParsingDurationMs += Date.now() - parseStart;

      logGenerationStageDiagnostic({
        requestId,
        provider: lastUsedProvider,
        model: lastUsedModel,
        stage: "generating_entry",
        filePath: "App.tsx",
        attempt: appRetries + 1,
        responseLength: output.length,
        isTruncated: parsed.isTruncated,
        jsonParseError: parsed.error,
        jsonParsePosition: parsed.truncatedPosition,
        recoveredFilesCount: accumulatedFiles.length,
        incompleteFiles: parsed.isTruncated ? ["App.tsx"] : undefined,
        jobStatus: "generating_entry",
      });

      if (parsed.success && parsed.data?.files) {
        const valStart = Date.now();
        const validated = validateGenerationOutput(parsed.data);
        syntaxValidationDurationMs += Date.now() - valStart;

        if (validated.valid && validated.files && validated.files.length > 0) {
          accumulatedFiles = mergeGeneratedFiles(accumulatedFiles, validated.files);
          if (validated.dependencies) {
            Object.assign(accumulatedDeps, validated.dependencies);
          }
          appGenerated = true;
        } else if (validated.error) {
          lastAppError = validated.error;
          lastAppStatusCode = 502;
        }
      } else if (!parsed.success && parsed.error) {
        lastAppError = parsed.error;
        lastAppStatusCode = 502;
      }

      if (!appGenerated) {
        const recovered = extractCompleteFilesFromTruncatedJson(output);
        const appRecovered = recovered.find(
          (f) => f.path === "App.tsx" || f.path.endsWith("/App.tsx")
        );
        if (appRecovered) {
          accumulatedFiles = mergeGeneratedFiles(accumulatedFiles, [appRecovered]);
          appGenerated = true;
        }
      }
    } catch (err) {
      console.warn(`[Req ${requestId}] App.tsx generation attempt ${appRetries + 1} failed:`, err);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!lastAppError || !lastAppError.toLowerCase().includes("invalid typescript")) {
        lastAppError = errMsg;
      }
      lastAppStatusCode =
        (err as { status?: number; statusCode?: number })?.status ||
        (err as { status?: number; statusCode?: number })?.statusCode ||
        502;

      if (!isRetryableModelError(err)) {
        break;
      }
    }
    appRetries++;
  }

  if (!accumulatedFiles.some((f) => f.path === "App.tsx" || f.path.endsWith("/App.tsx"))) {
    const sanitizedReason = lastAppError
      ? (isTruncationError(lastAppError)
          ? "model response was truncated due to output token limits"
          : lastAppError)
      : "model failed to produce a valid App.tsx";
    const finalErr = new Error(
      `Meta Muse Spark generation failed at stage 'generating_entry' (App.tsx): ${sanitizedReason}.`
    );
    (finalErr as unknown as { status: number; statusCode: number }).status = lastAppStatusCode || 502;
    (finalErr as unknown as { status: number; statusCode: number }).statusCode = lastAppStatusCode || 502;
    throw finalErr;
  }

  checkPipelineDeadline("generating_entry");

  // --- STAGE 5: VALIDATE & REPAIR MISSING IMPORTS ---
  onProgress?.("Validating application syntax and relative imports...", 90, accumulatedFiles, "validating");

  const missingImports = findMissingLocalImports(accumulatedFiles);
  if (missingImports.length > 0) {
    const toRepair = missingImports.slice(0, 2);
    for (const missing of toRepair) {
      checkPipelineDeadline("recovering");
      onProgress?.(
        `Generating missing component: ${missing.missingPath}...`,
        95,
        accumulatedFiles,
        "recovering"
      );

      const repairPrompt = `Generate the missing component "${missing.missingPath}" required by "${missing.importedBy}".
Import statement in existing code:
"${missing.importStatement}"

Task:
Build a complete React TypeScript component for "${missing.missingPath}".
Return ONLY valid JSON:
{
  "files": [
    {
      "path": "${missing.missingPath}",
      "code": "complete code"
    }
  ],
  "dependencies": {}
}`;

      try {
        const repairOutput = await invokeModel(repairPrompt, "recovering");
        const parsed = safeParseJson<GenerationOutput>(repairOutput);

        logGenerationStageDiagnostic({
          requestId,
          provider: lastUsedProvider,
          model: lastUsedModel,
          stage: "recovering",
          filePath: missing.missingPath,
          attempt: 1,
          responseLength: repairOutput.length,
          isTruncated: parsed.isTruncated,
          jsonParseError: parsed.error,
          recoveredFilesCount: accumulatedFiles.length,
          jobStatus: "recovering",
        });

        if (parsed.success && parsed.data?.files) {
          const validated = validateGenerationOutput(parsed.data);
          if (validated.valid && validated.files) {
            accumulatedFiles = mergeGeneratedFiles(accumulatedFiles, validated.files);
            if (validated.dependencies) {
              Object.assign(accumulatedDeps, validated.dependencies);
            }
          }
        }
      } catch (repairErr) {
        console.warn(`[Req ${requestId}] Failed to repair missing import ${missing.missingPath}:`, repairErr);
      }
    }
  }

  // Final syntax verification
  const finalValStart = Date.now();
  const finalSyntaxErr = findFirstSyntaxError(accumulatedFiles);
  syntaxValidationDurationMs += Date.now() - finalValStart;

  if (finalSyntaxErr) {
    const synErr = new Error(
      `${lastUsedProvider} generated invalid TypeScript (${finalSyntaxErr}).`
    );
    (synErr as unknown as { status: number; statusCode: number }).status = 502;
    (synErr as unknown as { status: number; statusCode: number }).statusCode = 502;
    throw synErr;
  }

  onProgress?.("Application generation completed successfully.", 100, accumulatedFiles, "completed");

  const totalDurationMs = Date.now() - startPipelineTime;
  const timings: PipelineTimingInfo = {
    totalDurationMs,
    initialRequestDurationMs,
    continuationDurationMs,
    jsonParsingDurationMs,
    syntaxValidationDurationMs,
    modelCallsCount,
    recoveredFilesCount: accumulatedFiles.length,
    finalFilesCount: accumulatedFiles.length,
  };

  logGenerationStageDiagnostic({
    requestId,
    provider: lastUsedProvider,
    model: lastUsedModel,
    stage: "completed",
    attempt: modelCallsCount,
    recoveredFilesCount: accumulatedFiles.length,
    jobStatus: "completed",
  });

  return {
    files: accumulatedFiles,
    dependencies: accumulatedDeps,
    usedModel: lastUsedModel,
    usedProvider: lastUsedProvider,
    fallbackUsed,
    fallbackNotice,
    attemptsUsed: modelCallsCount,
    timings,
  };
}
