import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { VirtualWorkspace } from "./fileOps";
import {
  repairWorkspace,
  runRepairLoop,
  type RepairContext,
  type RepairAction,
} from "./repairLoop";

describe("Bounded Self-Repair Engine", () => {
  test("already-valid workspace makes zero repair calls and returns success", async () => {
    const ws = new VirtualWorkspace([
      {
        path: "App.tsx",
        code: "export default function App() { return <div>Valid App</div>; }",
      },
    ]);

    let callCount = 0;
    const mockRepair = async () => {
      callCount++;
      return [];
    };

    const result = await repairWorkspace(ws, mockRepair);

    assert.equal(result.success, true);
    assert.equal(result.attempts, 0);
    assert.equal(callCount, 0, "Repair function must not be called for already-valid workspace");
    assert.equal(result.remainingDiagnostics.length, 0);
    assert.match(result.outcomeReason, /already valid/i);
  });

  test("repair function fixes a syntax error on the first attempt", async () => {
    const ws = new VirtualWorkspace([
      {
        path: "App.tsx",
        code: `export default function App() {
  return (
    <div>
      <span>Broken
    </div>
  );
}`,
      },
    ]);

    let callCount = 0;
    const mockRepair = async (ctx: RepairContext): Promise<RepairAction[]> => {
      callCount++;
      assert.equal(ctx.attempt, 1);
      assert.equal(ctx.maxAttempts, 2);
      assert.ok(ctx.diagnostics.length > 0);

      return [
        {
          type: "update",
          path: "App.tsx",
          code: `export default function App() {
  return (
    <div>
      <span>Fixed</span>
    </div>
  );
}`,
        },
      ];
    };

    const result = await repairWorkspace(ws, mockRepair);

    assert.equal(result.success, true);
    assert.equal(result.attempts, 1);
    assert.equal(callCount, 1);
    assert.equal(result.remainingDiagnostics.length, 0);
    assert.match(result.outcomeReason, /repaired successfully in 1 attempt/i);
    assert.ok(ws.readFile("App.tsx").includes("<span>Fixed</span>"));
  });

  test("a second attempt fixes a remaining error across multiple files", async () => {
    // App.tsx and Button.tsx both have syntax errors initially
    const ws = new VirtualWorkspace([
      {
        path: "App.tsx",
        code: "export default function App() { return <div><span></div>; }",
      },
      {
        path: "Button.tsx",
        code: "export function Button() { const x = ; return <button>Click</button>; }",
      },
    ]);

    let callCount = 0;
    const mockRepair = async (ctx: RepairContext): Promise<RepairAction[]> => {
      callCount++;

      if (ctx.attempt === 1) {
        // Attempt 1: Fix App.tsx, but leave Button.tsx broken
        return [
          {
            type: "update",
            path: "App.tsx",
            code: "export default function App() { return <div><span>Fixed App</span></div>; }",
          },
        ];
      }

      if (ctx.attempt === 2) {
        // Attempt 2: Fix Button.tsx
        assert.equal(ctx.diagnostics.length, 1);
        assert.equal(ctx.diagnostics[0].path, "Button.tsx");

        return [
          {
            type: "update",
            path: "Button.tsx",
            code: "export function Button() { const x = 42; return <button>Click</button>; }",
          },
        ];
      }

      throw new Error("Should not exceed 2 attempts");
    };

    const result = await repairWorkspace(ws, mockRepair);

    assert.equal(result.success, true);
    assert.equal(result.attempts, 2);
    assert.equal(callCount, 2);
    assert.equal(result.remainingDiagnostics.length, 0);
    assert.match(result.outcomeReason, /repaired successfully in 2 attempts/i);
    assert.ok(ws.readFile("App.tsx").includes("Fixed App"));
    assert.ok(ws.readFile("Button.tsx").includes("const x = 42;"));
  });

  test("the engine never exceeds two attempts", async () => {
    const ws = new VirtualWorkspace([
      {
        path: "App.tsx",
        code: "const bad = ;",
      },
    ]);

    let callCount = 0;
    const mockRepair = async (): Promise<RepairAction[]> => {
      callCount++;
      // Return code that still contains a syntax error
      return [
        {
          type: "update",
          path: "App.tsx",
          code: `const stillBad = ; // attempt ${callCount}`,
        },
      ];
    };

    const result = await repairWorkspace(ws, mockRepair);

    assert.equal(result.success, false);
    assert.equal(result.attempts, 2);
    assert.equal(callCount, 2, "Engine must never call repair function more than 2 times");
    assert.ok(result.remainingDiagnostics.length > 0);
    assert.match(result.outcomeReason, /maximum 2 attempts/i);
  });

  test("persistent errors return failure status and remaining diagnostics", async () => {
    const ws = new VirtualWorkspace([
      {
        path: "App.tsx",
        code: "const x = ;",
      },
    ]);

    const mockRepair = async (ctx: RepairContext): Promise<RepairAction[]> => {
      return [
        {
          type: "update",
          path: "App.tsx",
          code: `const x = ; // attempt ${ctx.attempt}`,
        },
      ];
    };

    const result = await repairWorkspace(ws, mockRepair);

    assert.equal(result.success, false);
    assert.equal(result.attempts, 2);
    assert.ok(result.remainingDiagnostics.length > 0);
    assert.equal(result.remainingDiagnostics[0].path, "App.tsx");
    assert.match(result.outcomeReason, /repair failed/i);
  });

  test("repair function exceptions are handled safely and preserve workspace", async () => {
    const initialCode = "const broken = ;";
    const ws = new VirtualWorkspace([
      { path: "App.tsx", code: initialCode },
    ]);

    const mockRepairThrowing = async (): Promise<RepairAction[]> => {
      throw new Error("Simulated upstream model timeout / connection dropped");
    };

    const result = await repairWorkspace(ws, mockRepairThrowing);

    assert.equal(result.success, false);
    assert.equal(result.attempts, 1);
    assert.match(
      result.outcomeReason,
      /Repair function threw an error: Simulated upstream model timeout/i
    );
    assert.ok(result.remainingDiagnostics.length > 0);
    // Original workspace must remain intact
    assert.equal(ws.readFile("App.tsx"), initialCode);
  });

  test("invalid file operations do not corrupt the workspace and terminate safely", async () => {
    const initialCode = "export default function () { return <div><span></div>; }";
    const ws = new VirtualWorkspace([
      { path: "App.tsx", code: initialCode },
    ]);

    // Repair function proposes invalid file operations (updating non-existent file)
    const mockRepairInvalidOps = async (): Promise<RepairAction[]> => {
      return [
        {
          type: "update",
          path: "GhostFile.tsx",
          code: "export const fixed = true;",
        },
      ];
    };

    const result = await repairWorkspace(ws, mockRepairInvalidOps);

    assert.equal(result.success, false);
    assert.equal(result.attempts, 1);
    assert.match(result.outcomeReason, /Invalid file operations in repair batch/i);
    // Workspace must not be corrupted
    assert.equal(ws.readFile("App.tsx"), initialCode);
    assert.equal(ws.hasFile("GhostFile.tsx"), false);
  });

  test("no-progress repairs terminate without wasting further attempts", async () => {
    const ws = new VirtualWorkspace([
      { path: "App.tsx", code: "const x = ;" },
    ]);

    // 1. Returns empty changes array
    let callCount = 0;
    const mockRepairNoChanges = async (): Promise<RepairAction[]> => {
      callCount++;
      return [];
    };

    const resultEmpty = await repairWorkspace(ws, mockRepairNoChanges);
    assert.equal(resultEmpty.success, false);
    assert.equal(resultEmpty.attempts, 1);
    assert.equal(callCount, 1, "Must terminate immediately upon 0 changes");
    assert.match(resultEmpty.outcomeReason, /returned 0 file changes/i);

    // 2. Returns identical code (no-op update)
    let callCountIdentical = 0;
    const mockRepairIdentical = async (): Promise<RepairAction[]> => {
      callCountIdentical++;
      return [
        {
          type: "update",
          path: "App.tsx",
          code: "const x = ;",
        },
      ];
    };

    const resultIdentical = await repairWorkspace(ws, mockRepairIdentical);
    assert.equal(resultIdentical.success, false);
    assert.equal(resultIdentical.attempts, 1);
    assert.equal(callCountIdentical, 1);
    assert.match(resultIdentical.outcomeReason, /identical to existing files/i);
  });

  test("handles multiple files correctly and preserves unmodified files", async () => {
    const ws = new VirtualWorkspace([
      {
        path: "App.tsx",
        code: "import { Header } from './Header'; export default function App() { return <Header />; }",
      },
      {
        path: "Header.tsx",
        code: "export function Header() { return <h1>Broken<span></h1>; }",
      },
      {
        path: "Footer.tsx",
        code: "export function Footer() { return <footer>Footer</footer>; }",
      },
    ]);

    const mockRepair = async (ctx: RepairContext): Promise<RepairAction[]> => {
      assert.equal(ctx.files.length, 3);
      assert.equal(ctx.diagnostics.length, 1);
      assert.equal(ctx.diagnostics[0].path, "Header.tsx");

      return [
        {
          type: "update",
          path: "Header.tsx",
          code: "export function Header() { return <h1>Broken<span></span></h1>; }",
        },
      ];
    };

    const result = await repairWorkspace(ws, mockRepair);

    assert.equal(result.success, true);
    assert.equal(result.attempts, 1);
    assert.equal(result.remainingDiagnostics.length, 0);

    // Unmodified files must remain unchanged
    assert.ok(ws.readFile("App.tsx").includes("export default function App()"));
    assert.ok(ws.readFile("Footer.tsx").includes("<footer>Footer</footer>"));
    // Modified file must be fixed
    assert.ok(ws.readFile("Header.tsx").includes("<span></span>"));
  });

  test("auto-normalizes repair actions provided without explicit 'type'", async () => {
    const ws = new VirtualWorkspace([
      { path: "App.tsx", code: "const invalid = ;" },
    ]);

    // Provide without type (similar to AI Edit endpoint returning { path, code }[])
    const mockRepairWithoutType = async (): Promise<RepairAction[]> => {
      return [
        {
          path: "App.tsx",
          code: "const invalid = 100;",
        },
      ];
    };

    const result = await repairWorkspace(ws, mockRepairWithoutType);
    assert.equal(result.success, true);
    assert.equal(ws.readFile("App.tsx"), "const invalid = 100;");
  });

  test("runRepairLoop alias functions identically to repairWorkspace", async () => {
    const ws = new VirtualWorkspace([
      { path: "App.tsx", code: "export default function App() { return <div>OK</div>; }" },
    ]);

    const result = await runRepairLoop(ws, async () => []);
    assert.equal(result.success, true);
    assert.equal(result.attempts, 0);
  });
});
