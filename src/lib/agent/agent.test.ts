import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeWorkspacePath,
  VirtualWorkspace,
  WorkspacePathError,
  WorkspaceFileNotFoundError,
  WorkspaceFileExistsError,
  readFile,
  createFile,
  updateFile,
  deleteFile,
  applyControlledChanges,
  type VirtualFile,
  type FileChangeOperation,
} from "./fileOps";
import {
  getSyntaxDiagnosticsForFile,
  getWorkspaceSyntaxDiagnostics,
  findFirstSyntaxDiagnostic,
  formatDiagnostic,
  type SyntaxDiagnostic,
} from "./diagnostics";

describe("VirtualWorkspace: Path Normalization & Security", () => {
  test("normalizes standard relative paths consistently", () => {
    assert.equal(normalizeWorkspacePath("App.tsx"), "App.tsx");
    assert.equal(
      normalizeWorkspacePath("components/Button.tsx"),
      "components/Button.tsx"
    );
    assert.equal(
      normalizeWorkspacePath("src/utils/helpers.ts"),
      "src/utils/helpers.ts"
    );
  });

  test("normalizes redundant slashes and current-directory './' references", () => {
    assert.equal(normalizeWorkspacePath("./App.tsx"), "App.tsx");
    assert.equal(
      normalizeWorkspacePath("./components/./Button.tsx"),
      "components/Button.tsx"
    );
    assert.equal(
      normalizeWorkspacePath("components//Button.tsx"),
      "components/Button.tsx"
    );
    assert.equal(
      normalizeWorkspacePath("src///utils/./helpers.ts"),
      "src/utils/helpers.ts"
    );
  });

  test("standardizes Windows backslashes into forward slashes", () => {
    assert.equal(
      normalizeWorkspacePath("components\\Button.tsx"),
      "components/Button.tsx"
    );
    assert.equal(
      normalizeWorkspacePath(".\\src\\components\\Card.tsx"),
      "src/components/Card.tsx"
    );
  });

  test("rejects empty, whitespace-only, or non-string paths", () => {
    assert.throws(
      () => normalizeWorkspacePath(""),
      WorkspacePathError,
      "rejects empty string"
    );
    assert.throws(
      () => normalizeWorkspacePath("   \t\n  "),
      WorkspacePathError,
      "rejects whitespace"
    );
    assert.throws(
      () => normalizeWorkspacePath(null as unknown as string),
      WorkspacePathError,
      "rejects null"
    );
    assert.throws(
      () => normalizeWorkspacePath(undefined as unknown as string),
      WorkspacePathError,
      "rejects undefined"
    );
  });

  test("rejects paths with null bytes or control characters", () => {
    assert.throws(
      () => normalizeWorkspacePath("App.tsx\0.js"),
      WorkspacePathError
    );
    assert.throws(
      () => normalizeWorkspacePath("components/\x01Button.tsx"),
      WorkspacePathError
    );
  });

  test("rejects root and absolute paths", () => {
    assert.throws(() => normalizeWorkspacePath("/App.tsx"), WorkspacePathError);
    assert.throws(() => normalizeWorkspacePath("/etc/passwd"), WorkspacePathError);
    assert.throws(() => normalizeWorkspacePath("\\App.tsx"), WorkspacePathError);
  });

  test("rejects Windows drive letters", () => {
    assert.throws(() => normalizeWorkspacePath("C:/App.tsx"), WorkspacePathError);
    assert.throws(() => normalizeWorkspacePath("c:\\Windows\\System32"), WorkspacePathError);
    assert.throws(() => normalizeWorkspacePath("D:relative.tsx"), WorkspacePathError);
  });

  test("rejects UNC network paths", () => {
    assert.throws(
      () => normalizeWorkspacePath("\\\\server\\share\\App.tsx"),
      WorkspacePathError
    );
    assert.throws(
      () => normalizeWorkspacePath("//server/share/App.tsx"),
      WorkspacePathError
    );
  });

  test("rejects URL schemes", () => {
    assert.throws(
      () => normalizeWorkspacePath("file:///c:/Projects/App.tsx"),
      WorkspacePathError
    );
    assert.throws(
      () => normalizeWorkspacePath("http://example.com/App.tsx"),
      WorkspacePathError
    );
  });

  test("rejects path traversal attempting to escape virtual workspace", () => {
    assert.throws(() => normalizeWorkspacePath("../App.tsx"), WorkspacePathError);
    assert.throws(
      () => normalizeWorkspacePath("components/../Button.tsx"),
      WorkspacePathError
    );
    assert.throws(
      () => normalizeWorkspacePath("a/b/../../c.tsx"),
      WorkspacePathError
    );
    assert.throws(
      () => normalizeWorkspacePath("./.."),
      WorkspacePathError
    );
  });
});

describe("VirtualWorkspace: In-Memory File Operations", () => {
  test("creates, reads, updates, and deletes virtual files correctly", () => {
    const ws = new VirtualWorkspace();

    // 1. Create file
    const created = ws.createFile("App.tsx", "export default function App() {}");
    assert.equal(created.path, "App.tsx");
    assert.equal(created.code, "export default function App() {}");
    assert.equal(ws.getFileCount(), 1);
    assert.equal(ws.hasFile("App.tsx"), true);

    // 2. Read file
    const content = ws.readFile("App.tsx");
    assert.equal(content, "export default function App() {}");

    // Also reads via path with redundant segments
    assert.equal(ws.readFile("./App.tsx"), "export default function App() {}");

    // 3. Update file
    const updated = ws.updateFile("App.tsx", "export default function App() { return 1; }");
    assert.equal(updated.code, "export default function App() { return 1; }");
    assert.equal(ws.readFile("App.tsx"), "export default function App() { return 1; }");

    // 4. Delete file
    const deleted = ws.deleteFile("App.tsx");
    assert.equal(deleted, true);
    assert.equal(ws.hasFile("App.tsx"), false);
    assert.equal(ws.getFileCount(), 0);
  });

  test("duplicate creation throws WorkspaceFileExistsError without silent overwrite", () => {
    const ws = new VirtualWorkspace();
    ws.createFile("App.tsx", "initial code");

    assert.throws(
      () => ws.createFile("App.tsx", "overwriting code"),
      WorkspaceFileExistsError
    );
    assert.throws(
      () => ws.createFile("./App.tsx", "overwriting code 2"),
      WorkspaceFileExistsError
    );

    // Ensure the original content was not modified
    assert.equal(ws.readFile("App.tsx"), "initial code");
  });

  test("missing file operations throw WorkspaceFileNotFoundError", () => {
    const ws = new VirtualWorkspace();

    assert.throws(
      () => ws.readFile("NonExistent.tsx"),
      WorkspaceFileNotFoundError
    );
    assert.throws(
      () => ws.updateFile("NonExistent.tsx", "new code"),
      WorkspaceFileNotFoundError
    );
    assert.throws(
      () => ws.deleteFile("NonExistent.tsx"),
      WorkspaceFileNotFoundError
    );
  });

  test("functional wrappers perform identically to class methods", () => {
    const ws = new VirtualWorkspace();
    createFile(ws, "Button.tsx", "export function Button() {}");
    assert.equal(readFile(ws, "Button.tsx"), "export function Button() {}");

    updateFile(ws, "Button.tsx", "export function Button() { return null; }");
    assert.equal(readFile(ws, "Button.tsx"), "export function Button() { return null; }");

    deleteFile(ws, "Button.tsx");
    assert.equal(ws.hasFile("Button.tsx"), false);
  });

  test("applyControlledChanges applies batch of create, update, delete operations", () => {
    const ws = new VirtualWorkspace([
      { path: "App.tsx", code: "v1 App" },
      { path: "OldComponent.tsx", code: "to be deleted" },
    ]);

    const changes: FileChangeOperation[] = [
      { type: "update", path: "App.tsx", code: "v2 App" },
      { type: "create", path: "NewComponent.tsx", code: "export function New() {}" },
      { type: "delete", path: "OldComponent.tsx" },
    ];

    const result = applyControlledChanges(ws, changes);
    assert.equal(result.appliedCount, 3);
    assert.deepEqual(result.created, ["NewComponent.tsx"]);
    assert.deepEqual(result.updated, ["App.tsx"]);
    assert.deepEqual(result.deleted, ["OldComponent.tsx"]);

    assert.equal(ws.readFile("App.tsx"), "v2 App");
    assert.equal(ws.readFile("NewComponent.tsx"), "export function New() {}");
    assert.equal(ws.hasFile("OldComponent.tsx"), false);
  });

  test("applyControlledChanges provides atomic rollback on any failure", () => {
    const ws = new VirtualWorkspace([
      { path: "App.tsx", code: "initial" },
    ]);

    // This batch tries to create New.tsx (valid), but also update Missing.tsx (invalid).
    const invalidBatch: FileChangeOperation[] = [
      { type: "create", path: "New.tsx", code: "new code" },
      { type: "update", path: "Missing.tsx", code: "fails" },
    ];

    assert.throws(() => ws.applyControlledChanges(invalidBatch), WorkspaceFileNotFoundError);

    // Workspace must remain completely unmutated
    assert.equal(ws.getFileCount(), 1);
    assert.equal(ws.hasFile("New.tsx"), false);
    assert.equal(ws.readFile("App.tsx"), "initial");
  });

  test("applyControlledChanges rejects duplicate creation without silent overwrite", () => {
    const ws = new VirtualWorkspace([
      { path: "App.tsx", code: "existing" },
    ]);

    const duplicateBatch: FileChangeOperation[] = [
      { type: "create", path: "App.tsx", code: "silently overwrite?" },
    ];

    assert.throws(() => ws.applyControlledChanges(duplicateBatch), WorkspaceFileExistsError);
    assert.equal(ws.readFile("App.tsx"), "existing");
  });

  test("handles empty workspace cleanly", () => {
    const ws = new VirtualWorkspace();
    assert.equal(ws.getFileCount(), 0);
    assert.deepEqual(ws.listFiles(), []);
    assert.deepEqual(ws.getFilePaths(), []);
    assert.deepEqual(ws.toRecord(), {});
  });

  test("initialization with VirtualFile array or Record works", () => {
    const ws1 = new VirtualWorkspace([
      { path: "App.tsx", code: "export default App;" },
      { path: "components/Header.tsx", code: "export function Header() {}" },
    ]);
    assert.equal(ws1.getFileCount(), 2);
    assert.equal(ws1.hasFile("App.tsx"), true);
    assert.equal(ws1.hasFile("components/Header.tsx"), true);

    const ws2 = new VirtualWorkspace({
      "index.ts": "console.log('init');",
      "styles.css": "body { margin: 0; }",
    });
    assert.equal(ws2.getFileCount(), 2);
    assert.equal(ws2.readFile("index.ts"), "console.log('init');");
  });

  test("listFiles returns files sorted deterministically by path", () => {
    const ws = new VirtualWorkspace();
    ws.createFile("z.ts", "z");
    ws.createFile("a.ts", "a");
    ws.createFile("m.ts", "m");

    const files = ws.listFiles();
    assert.deepEqual(
      files.map((f) => f.path),
      ["a.ts", "m.ts", "z.ts"]
    );
  });

  test("prevents mutation of workspace state through caller references (defensive copies)", () => {
    const initialArray: VirtualFile[] = [
      { path: "App.tsx", code: "initial code" },
    ];
    const ws = new VirtualWorkspace(initialArray);

    // Mutate the original caller array
    initialArray[0].code = "mutated code";
    assert.equal(ws.readFile("App.tsx"), "initial code");

    // Mutate an array item returned from listFiles()
    const listedFiles = ws.listFiles();
    listedFiles[0].code = "listed mutated";
    assert.equal(ws.readFile("App.tsx"), "initial code");
  });

  test("clone() creates an independent and isolated workspace", () => {
    const wsOriginal = new VirtualWorkspace([
      { path: "App.tsx", code: "version 1" },
    ]);
    const wsClone = wsOriginal.clone();

    wsClone.updateFile("App.tsx", "version 2");
    wsClone.createFile("NewFile.tsx", "new content");

    assert.equal(wsOriginal.readFile("App.tsx"), "version 1");
    assert.equal(wsOriginal.hasFile("NewFile.tsx"), false);
    assert.equal(wsClone.readFile("App.tsx"), "version 2");
    assert.equal(wsClone.hasFile("NewFile.tsx"), true);
  });

  test("multiple workspace instances maintain complete isolation", () => {
    const ws1 = new VirtualWorkspace();
    const ws2 = new VirtualWorkspace();

    ws1.createFile("File1.ts", "code 1");
    assert.equal(ws1.hasFile("File1.ts"), true);
    assert.equal(ws2.hasFile("File1.ts"), false);
  });

  test("confirms virtual file operations do not alter real disk filesystem", () => {
    const dummyPath = "test-virtual-sandbox-file.tsx";
    const ws = new VirtualWorkspace();
    ws.createFile(dummyPath, "export const secret = 42;");

    // File must exist in the virtual workspace
    assert.equal(ws.hasFile(dummyPath), true);

    // File must NOT exist in the real file system
    const realDiskPath = path.resolve(process.cwd(), dummyPath);
    assert.equal(
      fs.existsSync(realDiskPath),
      false,
      "Virtual file must not be written to disk"
    );
  });
});

describe("TypeScript Syntax Diagnostics Engine", () => {
  test("returns empty diagnostic list for syntactically valid TypeScript/TSX code", () => {
    const validTSX: VirtualFile = {
      path: "App.tsx",
      code: `
import React, { useState } from "react";

export default function Counter() {
  const [count, setCount] = useState<number>(0);
  return (
    <div className="p-4">
      <h1 className="text-xl">Count: {count}</h1>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  );
}
`,
    };

    const diagnostics = getSyntaxDiagnosticsForFile(validTSX);
    assert.equal(diagnostics.length, 0);
  });

  test("returns empty diagnostics for empty workspace or file list", () => {
    assert.deepEqual(getWorkspaceSyntaxDiagnostics([]), []);
    assert.deepEqual(getWorkspaceSyntaxDiagnostics(new VirtualWorkspace()), []);
    assert.equal(findFirstSyntaxDiagnostic([]), null);
  });

  test("handles empty code file without crashing", () => {
    const emptyFile: VirtualFile = { path: "Empty.tsx", code: "" };
    assert.deepEqual(getSyntaxDiagnosticsForFile(emptyFile), []);
  });

  test("captures unclosed JSX element and returns line, column, code, and snippet", () => {
    const brokenTSX: VirtualFile = {
      path: "App.tsx",
      code: `export default function App() {
  return (
    <div>
      <span>Broken Element
    </div>
  );
}`,
    };

    const diagnostics = getSyntaxDiagnosticsForFile(brokenTSX);
    assert.ok(diagnostics.length > 0, "Should detect at least 1 syntax error");

    const diag = diagnostics[0];
    assert.equal(diag.path, "App.tsx");
    assert.ok(diag.line >= 4, `Line should be near unclosed tag, got: ${diag.line}`);
    assert.ok(typeof diag.character === "number" && diag.character > 0);
    assert.equal(diag.column, diag.character);
    assert.match(diag.message, /JSX element 'span' has no corresponding closing tag/i);
    assert.equal(diag.code, 17008);
    assert.ok(typeof diag.codeSnippet === "string" && diag.codeSnippet.length > 0);
  });

  test("captures missing expression and unclosed brace in TypeScript with correct line/col", () => {
    const brokenTS: VirtualFile = {
      path: "utils/broken.ts",
      code: `const invalid = ;
const missingClosingBrace = { a: 1;
`,
    };

    const diagnostics = getSyntaxDiagnosticsForFile(brokenTS);
    assert.ok(diagnostics.length >= 2, "Should capture multiple syntax errors");

    const first = diagnostics[0];
    assert.equal(first.path, "utils/broken.ts");
    assert.equal(first.line, 1);
    assert.equal(first.column, 17);
    assert.match(first.message, /Expression expected/i);
    assert.equal(first.codeSnippet, "const invalid = ;");
  });

  test("captures unterminated regular expression literal", () => {
    const brokenRegex: VirtualFile = {
      path: "regex.ts",
      code: "const badRegex = /[^0-9];\nconst next = 10;",
    };

    const diagnostics = getSyntaxDiagnosticsForFile(brokenRegex);
    assert.ok(diagnostics.length > 0);
    const regexDiag = diagnostics.find((d) =>
      d.message.toLowerCase().includes("unterminated regular expression")
    );
    assert.ok(regexDiag, "Should find unterminated regex diagnostic");
    assert.equal(regexDiag?.line, 1);
    assert.ok(regexDiag?.column !== undefined);
  });

  test("validates multi-file workspace, isolating clean files from broken files", () => {
    const ws = new VirtualWorkspace([
      {
        path: "Clean.tsx",
        code: "export function Clean() { return <div>OK</div>; }",
      },
      {
        path: "Broken1.tsx",
        code: "export function Broken1() { return <div><span></div>; }",
      },
      {
        path: "Broken2.ts",
        code: "const val = ;",
      },
    ]);

    const allDiagnostics = getWorkspaceSyntaxDiagnostics(ws);
    assert.ok(allDiagnostics.length >= 2);

    const pathsWithErrors = new Set(allDiagnostics.map((d) => d.path));
    assert.equal(pathsWithErrors.has("Clean.tsx"), false);
    assert.equal(pathsWithErrors.has("Broken1.tsx"), true);
    assert.equal(pathsWithErrors.has("Broken2.ts"), true);

    const firstDiag = findFirstSyntaxDiagnostic(ws);
    assert.ok(firstDiag !== null);
    assert.ok(firstDiag.path === "Broken1.tsx" || firstDiag.path === "Broken2.ts");
  });

  test("safely skips non-TS/JS files (e.g. css, json, md)", () => {
    const cssFile: VirtualFile = {
      path: "styles.css",
      code: ".btn { background: blue; /* valid css, not ts */ }",
    };
    const mdFile: VirtualFile = {
      path: "README.md",
      code: "# Documentation\nSome markdown text with <div> tag.",
    };

    assert.deepEqual(getSyntaxDiagnosticsForFile(cssFile), []);
    assert.deepEqual(getSyntaxDiagnosticsForFile(mdFile), []);
  });

  test("formats diagnostics into readable strings with path, line, column, and snippet", () => {
    const diag: SyntaxDiagnostic = {
      path: "App.tsx",
      line: 12,
      character: 5,
      column: 5,
      message: "JSX element 'div' has no corresponding closing tag.",
      code: 17008,
      codeSnippet: "<div>Hello",
    };

    const formatted = formatDiagnostic(diag);
    assert.ok(formatted.includes("App.tsx:12:5"));
    assert.ok(formatted.includes("TS17008"));
    assert.ok(formatted.includes("JSX element 'div'"));
    assert.ok(formatted.includes("> <div>Hello"));
  });

  test("preserves distinct boundary: syntactic validation ignores type errors & missing packages", () => {
    // This code is SYNTACTICALLY VALID even though "missing-package" is not installed
    // and a number variable is assigned a string.
    // getSyntaxDiagnosticsForFile must NOT report type/module errors.
    const validSyntaxWithSemanticErrors: VirtualFile = {
      path: "App.tsx",
      code: `
import { nonExistentFunction } from "completely-missing-package";

const num: number = "this is a string, which is a type mismatch";
export default function App() {
  return <div>{nonExistentFunction(num)}</div>;
}
`,
    };

    const diagnostics = getSyntaxDiagnosticsForFile(validSyntaxWithSemanticErrors);
    assert.equal(
      diagnostics.length,
      0,
      "Syntactic check must strictly check grammar, not semantic type resolution"
    );
  });
});
