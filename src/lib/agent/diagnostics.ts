import ts from "typescript";
import { VirtualFile, VirtualWorkspace } from "./fileOps";

export interface SyntaxDiagnostic {
  path: string;
  line: number;
  character: number;
  column: number;
  message: string;
  code?: number;
  codeSnippet?: string;
}

function getScriptKindForPath(path: string): ts.ScriptKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".ts")) return ts.ScriptKind.TS;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return null;
}

function extractCodeSnippet(code: string, lineIndex: number): string | undefined {
  if (lineIndex < 0) return undefined;
  const lines = code.split(/\r?\n/);
  if (lineIndex >= lines.length) return undefined;
  const lineText = lines[lineIndex].trim();
  if (!lineText) return undefined;
  if (lineText.length > 200) {
    return lineText.slice(0, 197) + "...";
  }
  return lineText;
}

/**
 * Validates syntactic correctness of a single virtual code file using TypeScript compiler API.
 * Only inspects syntax / grammar (unclosed tags, missing brackets, bad literals, malformed tokens).
 * Does NOT perform semantic type-checking, module resolution, or runtime error detection.
 */
export function getSyntaxDiagnosticsForFile(file: VirtualFile): SyntaxDiagnostic[] {
  if (!file || typeof file.path !== "string" || typeof file.code !== "string") {
    return [];
  }

  const scriptKind = getScriptKindForPath(file.path);
  if (scriptKind === null) {
    return [];
  }

  const sourceFile = ts.createSourceFile(
    file.path,
    file.code,
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
    getSourceFile: (fileName) => (fileName === file.path ? sourceFile : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => fileName === file.path,
    readFile: (fileName) => (fileName === file.path ? file.code : undefined),
  };

  const program = ts.createProgram([file.path], compilerOptions, host);
  const tsDiagnostics = program.getSyntacticDiagnostics(sourceFile);

  if (tsDiagnostics.length === 0) {
    return [];
  }

  return tsDiagnostics.map((diagnostic) => {
    let line = 1;
    let character = 1;
    let codeSnippet: string | undefined;

    if (typeof diagnostic.start === "number" && diagnostic.start >= 0) {
      const pos = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
      line = pos.line + 1;
      character = pos.character + 1;
      codeSnippet = extractCodeSnippet(file.code, pos.line);
    }

    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

    return {
      path: file.path,
      line,
      character,
      column: character,
      message,
      code: typeof diagnostic.code === "number" ? diagnostic.code : undefined,
      codeSnippet,
    };
  });
}

/**
 * Validates syntax across all files in a VirtualWorkspace or file list.
 */
export function getWorkspaceSyntaxDiagnostics(
  workspaceOrFiles: VirtualWorkspace | readonly VirtualFile[] | VirtualFile[]
): SyntaxDiagnostic[] {
  const fileList =
    workspaceOrFiles instanceof VirtualWorkspace
      ? workspaceOrFiles.listFiles()
      : Array.isArray(workspaceOrFiles)
      ? workspaceOrFiles
      : [];

  const results: SyntaxDiagnostic[] = [];
  for (const file of fileList) {
    results.push(...getSyntaxDiagnosticsForFile(file));
  }
  return results;
}

/**
 * Finds the first syntax diagnostic, short-circuiting as soon as an error is encountered.
 */
export function findFirstSyntaxDiagnostic(
  workspaceOrFiles: VirtualWorkspace | readonly VirtualFile[] | VirtualFile[]
): SyntaxDiagnostic | null {
  const fileList =
    workspaceOrFiles instanceof VirtualWorkspace
      ? workspaceOrFiles.listFiles()
      : Array.isArray(workspaceOrFiles)
      ? workspaceOrFiles
      : [];

  for (const file of fileList) {
    const diagnostics = getSyntaxDiagnosticsForFile(file);
    if (diagnostics.length > 0) {
      return diagnostics[0];
    }
  }
  return null;
}

/**
 * Human-readable string formatting for a syntax diagnostic.
 */
export function formatDiagnostic(diag: SyntaxDiagnostic): string {
  const codeStr = diag.code ? ` (TS${diag.code})` : "";
  const snippetStr = diag.codeSnippet ? `\n  > ${diag.codeSnippet}` : "";
  return `${diag.path}:${diag.line}:${diag.column} - error${codeStr}: ${diag.message}${snippetStr}`;
}
