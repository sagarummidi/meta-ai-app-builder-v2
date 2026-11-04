import ts from "typescript";
import {
  type ModelRouter,
  type ModelProviderType,
} from "./modelRouter";
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

  // 2. Scan for root JSON object starting at first '{'
  const firstBraceIndex = targetText.indexOf("{");
  if (firstBraceIndex === -1) {
    return { extractedText: targetText, isTruncated: fenceTruncated, fenceFound };
  }

  let insideString = false;
  let braceDepth = 0;
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
      }
    }
  }

  if (endIndex !== -1) {
    return {
      extractedText: targetText.slice(firstBraceIndex, endIndex + 1),
      isTruncated: false,
      fenceFound,
    };
  }

  return {
    extractedText: targetText.slice(firstBraceIndex),
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
    repaired += '"';
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
        error: initialErr instanceof Error ? initialErr.message : String(initialErr),
      };
    } catch {
      return {
        success: false,
        isTruncated,
        error: initialErr instanceof Error ? initialErr.message : String(initialErr),
      };
    }
  }
}

/**
 * Extracts any completely formed files from a truncated JSON output.
 * Preserves already generated files while safely ignoring the cut-off file at the end.
 */
export function extractCompleteFilesFromTruncatedJson(rawText: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  if (!rawText || typeof rawText !== "string") return files;

  const filesKeyRegex = /"files"\s*:\s*\[/i;
  const match = rawText.match(filesKeyRegex);
  if (!match || match.index === undefined) return files;

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
  } = options;

  const startPipelineTime = Date.now();
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
          timeoutMs,
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

      const missingList =
        missingSet.size > 0
          ? Array.from(missingSet)
              .map((p) => `- ${p}`)
              .join("\n")
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

  throw new Error(
    `${lastUsedProvider} failed to generate a complete application.`
  );
}
