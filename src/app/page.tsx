"use client";

import { useState, useRef, useEffect, Component, type ReactNode, type ErrorInfo } from "react";
import { SandpackProvider, SandpackLayout, SandpackPreview } from "@codesandbox/sandpack-react";
import { MetaEmblem, MetaWordmark } from "./components/MetaEmblem";
import JSZip from "jszip";
import {
  createProject,
  deleteProject,
  listProjects,
  updateProject,
  saveActiveWorkspace,
  loadActiveWorkspace,
  clearActiveWorkspace,
  saveWorkspaceHistory,
  loadWorkspaceHistory,
  clearWorkspaceHistory,
  type SavedProject,
  type WorkspaceSnapshot,
} from "../lib/projectStore";
import {
  type ModelProviderType,
  DEFAULT_IMPROVE_INSTRUCTION,
  applyChangedFiles,
  mergeDependencies,
} from "../lib/modelRouter";
import {
  buildRepairPayload,
  computeWorkspaceFingerprint,
  isWorkspaceStale,
  canStartRepair,
  parseRepairResponse,
  mapRepairedFilesToAppFiles,
  type SyntaxDiagnostic,
} from "../lib/agent";

const MAX_PROMPT_LENGTH = 15000;
const MAX_INSTRUCTION_LENGTH = 15000;

interface ErrorBoundaryProps {
  children: ReactNode;
  onRepair?: () => void;
  isBusy?: boolean;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class PreviewErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Preview render error caught by boundary:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: "24px",
            background: "#1e293b",
            borderRadius: "12px",
            color: "#f87171",
            border: "1px solid #334155",
            minHeight: "300px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <h4 style={{ margin: "0 0 8px 0", fontSize: "16px", color: "#f87171" }}>
            Preview Error
          </h4>
          <p style={{ margin: "0 0 12px 0", fontSize: "14px", color: "#cbd5e1" }}>
            The preview encountered a runtime issue while rendering the generated code. Your code and edits are safely preserved in the editor.
          </p>
          <pre
            style={{
              padding: "10px",
              background: "#0f172a",
              borderRadius: "6px",
              fontSize: "12px",
              color: "#fca5a5",
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {this.state.error?.message || "Unknown rendering error"}
          </pre>
          <div style={{ display: "flex", gap: "10px", marginTop: "14px", alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              style={{
                padding: "8px 14px",
                borderRadius: "6px",
                border: "1px solid #475569",
                background: "#1e293b",
                color: "white",
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              🔄 Reload Preview
            </button>
            {this.props.onRepair && (
              <button
                onClick={this.props.onRepair}
                disabled={this.props.isBusy}
                style={{
                  padding: "8px 14px",
                  borderRadius: "6px",
                  border: "none",
                  background: this.props.isBusy ? "#4b5563" : "#0d9488",
                  color: "white",
                  fontSize: "13px",
                  cursor: this.props.isBusy ? "not-allowed" : "pointer",
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                🛠️ Repair with AI
              </button>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}


type AppType = "attendance" | "todo" | "calculator" | "shop" | "generic";

type AppFile = {
  name: string;
  code: string;
};


const QUICK_PROMPTS = [
  {
    icon: "✨",
    title: "Build a modern landing page",
    fullPrompt:
      "Build a modern SaaS landing page with a hero section, feature cards, pricing tiers with toggle, customer testimonials, and an interactive CTA button.",
  },
  {
    icon: "📊",
    title: "Create an analytics dashboard",
    fullPrompt:
      "Create an analytics dashboard with real-time revenue metrics, interactive chart visualizations, monthly user trends, and a recent transactions table.",
  },
  {
    icon: "🛒",
    title: "Build an e-commerce website",
    fullPrompt:
      "Build a modern e-commerce storefront with a product catalog, category filters, interactive product detail modal, and dynamic shopping cart with checkout preview.",
  },
  {
    icon: "✅",
    title: "Create a task management app",
    fullPrompt:
      "Create a Kanban-style task management app with draggable task cards, todo/in-progress/done columns, priority labels, search filter, and task creation modal.",
  },
];

const PIPELINE_STAGES = [
  { id: "planning", name: "Architecture Plan" },
  { id: "generating_shared", name: "Shared Types" },
  { id: "generating_components", name: "UI Components" },
  { id: "generating_entry", name: "App Orchestrator" },
  { id: "validating", name: "Validation & Repair" },
];

function getStageIndex(stageMsg: string | null): number {
  if (!stageMsg) return 0;
  const lower = stageMsg.toLowerCase();
  if (lower.includes("plan") || lower.includes("architect")) return 0;
  if (lower.includes("type") || lower.includes("shared") || lower.includes("interface")) return 1;
  if (lower.includes("component") || lower.includes("ui")) return 2;
  if (lower.includes("app.tsx") || lower.includes("entry") || lower.includes("orchestrat")) return 3;
  if (lower.includes("validat") || lower.includes("syntax") || lower.includes("repair")) return 4;
  return 0;
}

const defaultFiles: Record<AppType, AppFile[]> = {
  attendance: [
    {
      name: "page.tsx",
      code: `export default function AttendanceApp() {
  return (
    <main>
      <h1>Attendance App</h1>
      <p>Track attendance here.</p>
    </main>
  );
}`,
    },
  ],

  todo: [
    {
      name: "page.tsx",
      code: `export default function TodoApp() {
  return (
    <main>
      <h1>Todo App</h1>
      <input placeholder="Add a task" />
      <button>Add</button>
    </main>
  );
}`,
    },
  ],

  calculator: [
    {
      name: "page.tsx",
      code: `export default function CalculatorApp() {
  return (
    <main>
      <h1>Calculator</h1>
      <p>Calculator interface</p>
    </main>
  );
}`,
    },
  ],

  shop: [
    {
      name: "page.tsx",
      code: `export default function ShopApp() {
  return (
    <main>
      <h1>My Shop</h1>
      <p>Products will appear here.</p>
    </main>
  );
}`,
    },
  ],

  generic: [
    {
      name: "page.tsx",
      code: `export default function MyApp() {
  return (
    <main>
      <h1>My App</h1>
      <p>Your generated application will appear here.</p>
    </main>
  );
}`,
    },
  ],
};

const APP_TYPES: AppType[] = [
  "attendance",
  "todo",
  "calculator",
  "shop",
  "generic",
];

function isAppType(value: string): value is AppType {
  return (APP_TYPES as string[]).includes(value);
}

function detectAppType(prompt: string): AppType {
  const text = prompt.toLowerCase();

  if (
    text.includes("attendance") ||
    text.includes("student attendance")
  ) {
    return "attendance";
  }

  if (
    text.includes("todo") ||
    text.includes("to-do") ||
    text.includes("task")
  ) {
    return "todo";
  }

  if (
    text.includes("calculator") ||
    text.includes("calculate")
  ) {
    return "calculator";
  }

  if (
    text.includes("shop") ||
    text.includes("store") ||
    text.includes("ecommerce")
  ) {
    return "shop";
  }

  return "generic";
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);

  const [appType, setAppType] = useState<AppType>("generic");
  const [selectedFile, setSelectedFile] = useState("page.tsx");
  const [saved, setSaved] = useState(true);

  const [editInstruction, setEditInstruction] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState(false);

  const [improveLoading, setImproveLoading] = useState(false);
  const [improveError, setImproveError] = useState<string | null>(null);
  const [improveSuccess, setImproveSuccess] = useState(false);

  const [repairLoading, setRepairLoading] = useState(false);
  const [repairSuccess, setRepairSuccess] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [repairDiagnostics, setRepairDiagnostics] = useState<SyntaxDiagnostic[]>([]);
  const [repairOutcome, setRepairOutcome] = useState<string | null>(null);

  const [showProjects, setShowProjects] = useState(false);
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(
    null
  );

  const selectedProvider: ModelProviderType = "meta";
  const selectedModel = "muse-spark-1.3";

  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generationElapsed, setGenerationElapsed] = useState(0);
  const [generationStageMessage, setGenerationStageMessage] = useState<string | null>(null);
  const [generationProgressPercent, setGenerationProgressPercent] = useState<number | null>(null);

  useEffect(() => {
    if (!loading) return;
    const timer = setInterval(() => {
      setGenerationElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [loading]);

  function getGenerationProgressMessage(): string {
    if (generationStageMessage) {
      const pctStr = typeof generationProgressPercent === "number" ? ` [${generationProgressPercent}%]` : "";
      return `${generationStageMessage}${pctStr} (${generationElapsed}s)`;
    }
    if (generationElapsed < 5) {
      return "Connecting to Meta provider and initializing generation...";
    } else if (generationElapsed < 25) {
      return `Generating application components... (${generationElapsed}s)`;
    } else if (generationElapsed < 60) {
      return `Building complete project structure and types... (${generationElapsed}s)`;
    } else if (generationElapsed < 90) {
      return `Validating TypeScript syntax and recovering complete files... (${generationElapsed}s)`;
    } else {
      return `Finalizing application... Large codebases may take up to 2-3 minutes (${generationElapsed}s)`;
    }
  }

  const [pastSnapshots, setPastSnapshots] = useState<WorkspaceSnapshot[]>([]);
  const [futureSnapshots, setFutureSnapshots] = useState<WorkspaceSnapshot[]>([]);

  const isManualEditingRef = useRef(false);
  const manualEditTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [files, setFiles] =
    useState<Record<AppType, AppFile[]>>(defaultFiles);
  const [dependencies, setDependencies] =
    useState<Record<AppType, Record<string, string>>>({
      attendance: {},
      todo: {},
      calculator: {},
      shop: {},
      generic: {},
    });

  const isHydratedRef = useRef(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSavedProjects(listProjects());

    const activeWorkspace = loadActiveWorkspace();
    if (activeWorkspace) {
      setPrompt(activeWorkspace.prompt);
      if (isAppType(activeWorkspace.appType)) {
        setAppType(activeWorkspace.appType);
      }
      if (activeWorkspace.files) {
        setFiles((prev) => ({
          ...prev,
          ...activeWorkspace.files,
        }));
      }
      if (activeWorkspace.dependencies) {
        setDependencies((prev) => ({
          ...prev,
          ...activeWorkspace.dependencies,
        }));
      }
      setSelectedFile(activeWorkspace.selectedFile || "page.tsx");
      setShowWorkspace(activeWorkspace.showWorkspace);
      setCurrentProjectId(activeWorkspace.currentProjectId || null);
    }

    const history = loadWorkspaceHistory();
    if (history) {
      setPastSnapshots(history.pastSnapshots);
      setFutureSnapshots(history.futureSnapshots);
    }

    isHydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!isHydratedRef.current) {
      return;
    }

    if (showWorkspace) {
      saveActiveWorkspace({
        prompt,
        appType,
        files,
        dependencies,
        selectedFile,
        showWorkspace,
        currentProjectId,
      });
    }
  }, [
    prompt,
    appType,
    files,
    dependencies,
    selectedFile,
    showWorkspace,
    currentProjectId,
  ]);

  useEffect(() => {
    if (!isHydratedRef.current) {
      return;
    }

    saveWorkspaceHistory({
      pastSnapshots,
      futureSnapshots,
    });
  }, [pastSnapshots, futureSnapshots]);

  function createCurrentSnapshot(): WorkspaceSnapshot {
    return {
      prompt,
      appType,
      files,
      dependencies,
      selectedFile,
      showWorkspace,
      currentProjectId,
    };
  }

  function pushSnapshot(snapshotToPush?: WorkspaceSnapshot) {
    const snap = snapshotToPush || createCurrentSnapshot();
    setPastSnapshots((prev) => {
      if (prev.length > 0) {
        const last = prev[prev.length - 1];
        if (JSON.stringify(last) === JSON.stringify(snap)) {
          return prev;
        }
      }
      const updated = [...prev, snap];
      if (updated.length > 10) {
        return updated.slice(updated.length - 10);
      }
      return updated;
    });
    setFutureSnapshots([]);
  }

  function restoreSnapshot(snap: WorkspaceSnapshot) {
    setPrompt(snap.prompt);
    if (isAppType(snap.appType)) {
      setAppType(snap.appType);
    }
    setFiles(snap.files as Record<AppType, AppFile[]>);
    setDependencies(
      snap.dependencies as Record<AppType, Record<string, string>>
    );
    setSelectedFile(snap.selectedFile);
    setShowWorkspace(snap.showWorkspace);
    setCurrentProjectId(snap.currentProjectId);
  }

  function undo() {
    if (pastSnapshots.length === 0) return;

    if (manualEditTimerRef.current) {
      clearTimeout(manualEditTimerRef.current);
      manualEditTimerRef.current = null;
    }
    isManualEditingRef.current = false;

    const currentSnap = createCurrentSnapshot();
    const previousSnap = pastSnapshots[pastSnapshots.length - 1];
    const newPast = pastSnapshots.slice(0, pastSnapshots.length - 1);

    setPastSnapshots(newPast);
    setFutureSnapshots((prev) => [currentSnap, ...prev]);

    restoreSnapshot(previousSnap);
  }

  function redo() {
    if (futureSnapshots.length === 0) return;

    if (manualEditTimerRef.current) {
      clearTimeout(manualEditTimerRef.current);
      manualEditTimerRef.current = null;
    }
    isManualEditingRef.current = false;

    const currentSnap = createCurrentSnapshot();
    const nextSnap = futureSnapshots[0];
    const newFuture = futureSnapshots.slice(1);

    setPastSnapshots((prev) => {
      const updated = [...prev, currentSnap];
      return updated.length > 10 ? updated.slice(updated.length - 10) : updated;
    });
    setFutureSnapshots(newFuture);

    restoreSnapshot(nextSnap);
  }

  const isGeneratingRef = useRef(false);
  const isEditingRef = useRef(false);
  const isImprovingRef = useRef(false);
  const isRepairingRef = useRef(false);

  const isBusy = loading || editLoading || improveLoading || repairLoading;

  async function applyEdit() {
    if (
      isEditingRef.current ||
      isGeneratingRef.current ||
      isImprovingRef.current ||
      isRepairingRef.current ||
      isBusy
    )
      return;

    const trimmedInstruction = editInstruction.trim();
    if (!trimmedInstruction) return;

    if (trimmedInstruction.length > MAX_INSTRUCTION_LENGTH) {
      setEditError(
        `Edit instruction exceeds maximum allowed length of ${MAX_INSTRUCTION_LENGTH.toLocaleString()} characters.`
      );
      return;
    }

    isEditingRef.current = true;
    setEditLoading(true);
    setEditError(null);
    setEditSuccess(false);

    const reqId = Math.random().toString(36).substring(2, 10);

    try {
      let response: Response;
      try {
        response = await fetch("/api/edit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            instruction: trimmedInstruction,
            files: files[appType] || [],
            provider: selectedProvider,
            model: selectedModel,
            requestId: reqId,
          }),
        });
      } catch (fetchErr) {
        throw new Error(
          `Network error: Unable to reach the server. Please check your connection (${
            fetchErr instanceof Error ? fetchErr.message : "connection failure"
          }).`
        );
      }

      const responseText = await response.text();

      if (!responseText.trim()) {
        throw new Error(`The backend returned an empty response (HTTP ${response.status}).`);
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error(`[Req ${reqId}] Failed to parse edit response JSON:`, parseError);
        throw new Error("Invalid response format received from server.");
      }

      if (!response.ok || !data.success) {
        throw new Error(data.message || `Failed to apply edit (HTTP ${response.status})`);
      }

      if (data.fallbackNotice) {
        setFallbackNotice(data.fallbackNotice);
      } else {
        setFallbackNotice(null);
      }

      pushSnapshot();

      const rawChangedFiles = Array.isArray(data.changedFiles) ? data.changedFiles : [];
      setFiles((prevFiles) => ({
        ...prevFiles,
        [appType]: applyChangedFiles(prevFiles[appType] || [], rawChangedFiles),
      }));

      const safeDependencies =
        data.dependencies && typeof data.dependencies === "object" && !Array.isArray(data.dependencies)
          ? data.dependencies
          : {};

      setDependencies((prevDeps) => ({
        ...prevDeps,
        [appType]: mergeDependencies(prevDeps[appType] || {}, safeDependencies),
      }));

      setSaved(false);
      setEditSuccess(true);
      setEditInstruction("");
      setTimeout(() => setEditSuccess(false), 3000);
    } catch (error) {
      console.error(error);
      setEditError(
        error instanceof Error ? error.message : "An unknown error occurred"
      );
    } finally {
      isEditingRef.current = false;
      setEditLoading(false);
    }
  }

  async function improveApp() {
    if (
      isImprovingRef.current ||
      isGeneratingRef.current ||
      isEditingRef.current ||
      isRepairingRef.current ||
      isBusy
    ) {
      return;
    }

    const currentFiles = files[appType] || [];
    if (currentFiles.length === 0) {
      setImproveError("No project files available to improve.");
      return;
    }

    isImprovingRef.current = true;
    setImproveLoading(true);
    setImproveError(null);
    setImproveSuccess(false);

    const reqId = Math.random().toString(36).substring(2, 10);

    try {
      let response: Response;
      try {
        response = await fetch("/api/edit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            instruction: DEFAULT_IMPROVE_INSTRUCTION,
            files: currentFiles,
            provider: selectedProvider,
            model: selectedModel,
            requestId: reqId,
          }),
        });
      } catch (fetchErr) {
        throw new Error(
          `Network error: Unable to reach the server. Please check your connection (${
            fetchErr instanceof Error ? fetchErr.message : "connection failure"
          }).`
        );
      }

      const responseText = await response.text();

      if (!responseText.trim()) {
        throw new Error(`The backend returned an empty response (HTTP ${response.status}).`);
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error(`[Req ${reqId}] Failed to parse improve response JSON:`, parseError);
        throw new Error("Invalid response format received from server.");
      }

      if (!response.ok || !data.success) {
        throw new Error(data.message || `Failed to improve the app (HTTP ${response.status})`);
      }

      if (data.fallbackNotice) {
        setFallbackNotice(data.fallbackNotice);
      } else {
        setFallbackNotice(null);
      }

      pushSnapshot();

      const rawChangedFiles = Array.isArray(data.changedFiles) ? data.changedFiles : [];
      if (rawChangedFiles.length > 0) {
        setFiles((prevFiles) => ({
          ...prevFiles,
          [appType]: applyChangedFiles(prevFiles[appType] || [], rawChangedFiles),
        }));

        const safeDependencies =
          data.dependencies && typeof data.dependencies === "object" && !Array.isArray(data.dependencies)
            ? data.dependencies
            : {};

        setDependencies((prevDeps) => ({
          ...prevDeps,
          [appType]: mergeDependencies(prevDeps[appType] || {}, safeDependencies),
        }));

        setSaved(false);
      }

      setImproveSuccess(true);
      setTimeout(() => setImproveSuccess(false), 4000);
    } catch (error) {
      console.error("AI Improve error:", error);
      setImproveError(
        error instanceof Error ? error.message : "An unknown error occurred while improving the app."
      );
    } finally {
      isImprovingRef.current = false;
      setImproveLoading(false);
    }
  }

  async function repairApp() {
    if (!canStartRepair(isBusy, isRepairingRef.current)) {
      return;
    }

    const currentFiles = files[appType] || [];
    if (currentFiles.length === 0) {
      setRepairError("No project files available to repair.");
      return;
    }

    isRepairingRef.current = true;
    setRepairLoading(true);
    setRepairError(null);
    setRepairSuccess(null);
    setRepairDiagnostics([]);
    setRepairOutcome(null);

    const snapshotFingerprint = computeWorkspaceFingerprint(currentFiles);
    const reqId = Math.random().toString(36).substring(2, 10);

    try {
      const payload = buildRepairPayload(
        currentFiles,
        selectedProvider,
        selectedModel,
        reqId
      );

      let response: Response;
      try {
        response = await fetch("/api/agent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } catch (fetchErr) {
        throw new Error(
          `Network error: Unable to reach the agent repair service (${
            fetchErr instanceof Error ? fetchErr.message : "connection failure"
          }).`
        );
      }

      const responseText = await response.text();
      const data = parseRepairResponse(responseText);

      if (!response.ok || !data.success) {
        if (data.remainingDiagnostics && data.remainingDiagnostics.length > 0) {
          setRepairDiagnostics(data.remainingDiagnostics);
        }
        if (data.outcomeReason) {
          setRepairOutcome(data.outcomeReason);
        }
        throw new Error(
          data.message || data.outcomeReason || `Failed to repair code (HTTP ${response.status})`
        );
      }

      // Stale check: Ensure workspace has not changed while repair was in-flight
      const currentWorkspaceFiles = files[appType] || [];
      if (isWorkspaceStale(snapshotFingerprint, currentWorkspaceFiles)) {
        setRepairError(
          "Workspace was modified while repair was in progress. Repaired code was not applied to protect your edits."
        );
        return;
      }

      if (data.repaired && data.files && data.files.length > 0) {
        pushSnapshot();
        const updatedFiles = mapRepairedFilesToAppFiles(data.files);
        setFiles((prevFiles) => ({
          ...prevFiles,
          [appType]: updatedFiles,
        }));
        setSaved(false);
        setRepairSuccess(
          `Successfully repaired ${data.attempts || 1} error(s)! Workspace is now clean.`
        );
        setRepairOutcome(data.outcomeReason || null);
        setRepairDiagnostics([]);
      } else {
        // Workspace was already clean
        setRepairSuccess("Workspace is already valid — no syntax errors detected.");
        setRepairOutcome(data.outcomeReason || "Workspace already valid with no syntax errors.");
        setRepairDiagnostics([]);
      }
    } catch (error) {
      console.error("Agent Repair error:", error);
      setRepairError(
        error instanceof Error ? error.message : "An unknown error occurred during repair."
      );
    } finally {
      isRepairingRef.current = false;
      setRepairLoading(false);
    }
  }

  async function generateApp() {
    if (
      isGeneratingRef.current ||
      isEditingRef.current ||
      isImprovingRef.current ||
      isRepairingRef.current ||
      isBusy
    ) {
      return;
    }

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      alert("Please describe the app you want to build.");
      return;
    }

    if (trimmedPrompt.length > MAX_PROMPT_LENGTH) {
      alert(`Prompt exceeds maximum allowed length of ${MAX_PROMPT_LENGTH.toLocaleString()} characters.`);
      return;
    }

    isGeneratingRef.current = true;
    setLoading(true);
    setGenerationElapsed(0);
    setGenerationStageMessage(null);
    setGenerationProgressPercent(null);
    setGenerationError(null);
    setRepairSuccess(null);
    setRepairError(null);
    setRepairDiagnostics([]);
    setRepairOutcome(null);

    const reqId = Math.random().toString(36).substring(2, 10);

    try {
      let response: Response;
      try {
        response = await fetch("/api/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: trimmedPrompt,
            provider: selectedProvider,
            model: selectedModel,
            requestId: reqId,
            mode: "async",
          }),
        });
      } catch (fetchErr) {
        throw new Error(
          `Network error: Unable to reach the server. Please check your connection (${
            fetchErr instanceof Error ? fetchErr.message : "connection failure"
          }).`
        );
      }

      const responseText = await response.text();

      if (!responseText.trim()) {
        throw new Error(`The backend returned an empty response (HTTP ${response.status}).`);
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error(`[Req ${reqId}] Failed to parse generate response JSON:`, parseError);
        throw new Error("Invalid response format received from server.");
      }

      console.log(`[Req ${reqId}] Backend response:`, data);

      if (!response.ok || !data.success) {
        throw new Error(
          data.message || `Failed to generate the app (HTTP ${response.status}).`
        );
      }

      // If backend returned an async generation job, poll until completion
      if (data && typeof data === "object" && typeof (data as { jobId?: unknown }).jobId === "string") {
        const activeJobId = (data as { jobId: string }).jobId;
        let jobCompleted = false;
        let pollAttempts = 0;
        const maxPollAttempts = 440; // 11 minutes total polling window at ~1.5s interval (660s)
        let consecutiveNetworkErrors = 0;

        while (!jobCompleted && pollAttempts < maxPollAttempts) {
          const delayMs = pollAttempts < 5 ? 1000 : pollAttempts < 20 ? 1500 : 2000;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          pollAttempts++;

          let pollRes: Response;
          try {
            pollRes = await fetch(`/api/generate?jobId=${encodeURIComponent(activeJobId)}`);
            consecutiveNetworkErrors = 0;
          } catch (pollErr) {
            consecutiveNetworkErrors++;
            if (consecutiveNetworkErrors > 5) {
              throw new Error(
                `Lost connection to server while polling generation status (${
                  pollErr instanceof Error ? pollErr.message : "network failure"
                }).`
              );
            }
            continue;
          }

          const pollText = await pollRes.text();
          if (!pollText.trim()) continue;

          let pollData: Record<string, unknown> | null = null;
          try {
            pollData = JSON.parse(pollText);
          } catch {
            // Safely handle malformed or non-JSON error response from server
            if (!pollRes.ok) {
              const stripped = pollText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
              const snippet = stripped.length > 200 ? stripped.slice(0, 200) + "..." : stripped;
              throw new Error(snippet || `Generation failed (HTTP ${pollRes.status} ${pollRes.statusText}).`);
            }
            continue;
          }

          if (!pollData) continue;

          if (!pollRes.ok || pollData.success === false || pollData.status === "failed") {
            const rawMsg =
              typeof pollData.message === "string"
                ? pollData.message
                : typeof pollData.error === "string"
                ? pollData.error
                : `Generation failed (HTTP ${pollRes.status}).`;
            throw new Error(rawMsg);
          }

          if (pollData.status === "completed") {
            data = pollData;
            jobCompleted = true;
            break;
          }

          if (typeof pollData.stageMessage === "string" && pollData.stageMessage) {
            setGenerationStageMessage(pollData.stageMessage);
          }
          if (typeof pollData.progressPercent === "number") {
            setGenerationProgressPercent(pollData.progressPercent);
          }
        }

        if (!jobCompleted) {
          throw new Error("Generation timed out on client polling.");
        }
      }

      if (data.fallbackNotice) {
        setFallbackNotice(data.fallbackNotice);
      } else {
        setFallbackNotice(null);
      }

      pushSnapshot();

      const type = detectAppType(trimmedPrompt);

      const generatedCode =
        data.generatedCode ||
        `export default function GeneratedApp() {
  return (
    <main>
      <h1>Generated App</h1>
      <p>${trimmedPrompt}</p>
    </main>
  );
}`;

      const rawFiles = Array.isArray(data.files) ? data.files : [];
      const generatedFiles: AppFile[] = rawFiles
        .filter((file: unknown) => file && typeof (file as { path?: unknown }).path === "string" && typeof (file as { code?: unknown }).code === "string")
        .map((file: { path: string; code: string }) => ({
          name: file.path,
          code: file.code,
        }));

      if (generatedFiles.length === 0) {
        generatedFiles.push({
          name: "App.tsx",
          code: generatedCode,
        });
      }

      const safeDependencies =
        data.dependencies && typeof data.dependencies === "object" && !Array.isArray(data.dependencies)
          ? data.dependencies
          : {};

      setFiles((previousFiles) => ({
        ...previousFiles,
        [type]: generatedFiles,
      }));
      setDependencies((previousDependencies) => ({
        ...previousDependencies,
        [type]: safeDependencies,
      }));

      setAppType(type);
      const hasAppTsx = generatedFiles.some((f) => f.name === "App.tsx");
      setSelectedFile(hasAppTsx ? "App.tsx" : generatedFiles[0]?.name || "App.tsx");
      setSaved(true);
      setShowWorkspace(true);
      setCurrentProjectId(null);
    } catch (error) {
      console.error("Generation error:", error);
      const rawMsg =
        error instanceof Error
          ? error.message
          : "Something went wrong while generating the app.";
      const isTimeout =
        /timed? ?out/i.test(rawMsg) ||
        /504/i.test(rawMsg) ||
        /gateway timeout/i.test(rawMsg);
      const msg = isTimeout
        ? `${rawMsg} You can try refining your prompt to be more concise or breaking it into smaller steps.`
        : rawMsg;
      setGenerationError(msg);
      alert(msg);
    } finally {
      isGeneratingRef.current = false;
      setLoading(false);
      setGenerationStageMessage(null);
      setGenerationProgressPercent(null);
    }
  }

  async function regenerateApp() {
    if (
      isGeneratingRef.current ||
      isEditingRef.current ||
      isImprovingRef.current ||
      isRepairingRef.current ||
      isBusy
    ) {
      return;
    }

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      alert("No generation prompt found to regenerate.");
      return;
    }

    if (trimmedPrompt.length > MAX_PROMPT_LENGTH) {
      alert(`Prompt exceeds maximum allowed length of ${MAX_PROMPT_LENGTH.toLocaleString()} characters.`);
      return;
    }

    if (!saved) {
      const confirmed = window.confirm(
        "You have unsaved changes in your current project. Regenerating will replace your current app with a fresh version. Do you want to continue?"
      );
      if (!confirmed) {
        return;
      }
    }

    isGeneratingRef.current = true;
    setLoading(true);
    setGenerationElapsed(0);
    setGenerationStageMessage(null);
    setGenerationProgressPercent(null);
    setGenerationError(null);
    setRepairSuccess(null);
    setRepairError(null);
    setRepairDiagnostics([]);
    setRepairOutcome(null);

    const reqId = Math.random().toString(36).substring(2, 10);

    try {
      let response: Response;
      try {
        response = await fetch("/api/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: trimmedPrompt,
            provider: selectedProvider,
            model: selectedModel,
            requestId: reqId,
            mode: "async",
          }),
        });
      } catch (fetchErr) {
        throw new Error(
          `Network error: Unable to reach the server. Please check your connection (${
            fetchErr instanceof Error ? fetchErr.message : "connection failure"
          }).`
        );
      }

      const responseText = await response.text();

      if (!responseText.trim()) {
        throw new Error(`The backend returned an empty response (HTTP ${response.status}).`);
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error(`[Req ${reqId}] Failed to parse regenerate response JSON:`, parseError);
        throw new Error("Invalid response format received from server.");
      }

      if (!response.ok || !data.success) {
        throw new Error(data.message || `Failed to regenerate the app (HTTP ${response.status}).`);
      }

      // If backend returned an async generation job, poll until completion
      if (data && typeof data === "object" && typeof (data as { jobId?: unknown }).jobId === "string") {
        const activeJobId = (data as { jobId: string }).jobId;
        let jobCompleted = false;
        let pollAttempts = 0;
        const maxPollAttempts = 440; // 11 minutes total polling window at ~1.5s interval (660s)
        let consecutiveNetworkErrors = 0;

        while (!jobCompleted && pollAttempts < maxPollAttempts) {
          const delayMs = pollAttempts < 5 ? 1000 : pollAttempts < 20 ? 1500 : 2000;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          pollAttempts++;

          let pollRes: Response;
          try {
            pollRes = await fetch(`/api/generate?jobId=${encodeURIComponent(activeJobId)}`);
            consecutiveNetworkErrors = 0;
          } catch (pollErr) {
            consecutiveNetworkErrors++;
            if (consecutiveNetworkErrors > 5) {
              throw new Error(
                `Lost connection to server while polling generation status (${
                  pollErr instanceof Error ? pollErr.message : "network failure"
                }).`
              );
            }
            continue;
          }

          const pollText = await pollRes.text();
          if (!pollText.trim()) continue;

          let pollData: Record<string, unknown> | null = null;
          try {
            pollData = JSON.parse(pollText);
          } catch {
            // Safely handle malformed or non-JSON error response from server
            if (!pollRes.ok) {
              const stripped = pollText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
              const snippet = stripped.length > 200 ? stripped.slice(0, 200) + "..." : stripped;
              throw new Error(snippet || `Generation failed (HTTP ${pollRes.status} ${pollRes.statusText}).`);
            }
            continue;
          }

          if (!pollData) continue;

          if (!pollRes.ok || pollData.success === false || pollData.status === "failed") {
            const rawMsg =
              typeof pollData.message === "string"
                ? pollData.message
                : typeof pollData.error === "string"
                ? pollData.error
                : `Generation failed (HTTP ${pollRes.status}).`;
            throw new Error(rawMsg);
          }

          if (pollData.status === "completed") {
            data = pollData;
            jobCompleted = true;
            break;
          }

          if (typeof pollData.stageMessage === "string" && pollData.stageMessage) {
            setGenerationStageMessage(pollData.stageMessage);
          }
          if (typeof pollData.progressPercent === "number") {
            setGenerationProgressPercent(pollData.progressPercent);
          }
        }

        if (!jobCompleted) {
          throw new Error("Generation timed out on client polling.");
        }
      }

      if (data.fallbackNotice) {
        setFallbackNotice(data.fallbackNotice);
      } else {
        setFallbackNotice(null);
      }

      pushSnapshot();

      const type = detectAppType(trimmedPrompt);

      const generatedCode =
        data.generatedCode ||
        `export default function GeneratedApp() {
  return (
    <main>
      <h1>Generated App</h1>
      <p>${trimmedPrompt}</p>
    </main>
  );
}`;

      const rawFiles = Array.isArray(data.files) ? data.files : [];
      const generatedFiles: AppFile[] = rawFiles
        .filter((file: unknown) => file && typeof (file as { path?: unknown }).path === "string" && typeof (file as { code?: unknown }).code === "string")
        .map((file: { path: string; code: string }) => ({
          name: file.path,
          code: file.code,
        }));

      if (generatedFiles.length === 0) {
        generatedFiles.push({
          name: "App.tsx",
          code: generatedCode,
        });
      }

      const safeDependencies =
        data.dependencies && typeof data.dependencies === "object" && !Array.isArray(data.dependencies)
          ? data.dependencies
          : {};

      setFiles((previousFiles) => ({
        ...previousFiles,
        [type]: generatedFiles,
      }));
      setDependencies((previousDependencies) => ({
        ...previousDependencies,
        [type]: safeDependencies,
      }));

      setAppType(type);
      const hasAppTsx = generatedFiles.some((f) => f.name === "App.tsx");
      setSelectedFile(hasAppTsx ? "App.tsx" : generatedFiles[0]?.name || "App.tsx");
      setSaved(true);
      setShowWorkspace(true);
      setCurrentProjectId(null);
    } catch (error) {
      console.error("Regeneration error:", error);
      const rawMsg =
        error instanceof Error
          ? error.message
          : "Something went wrong while regenerating the app.";
      const isTimeout =
        /timed? ?out/i.test(rawMsg) ||
        /504/i.test(rawMsg) ||
        /gateway timeout/i.test(rawMsg);
      const msg = isTimeout
        ? `${rawMsg} You can try refining your prompt to be more concise or breaking it into smaller steps.`
        : rawMsg;
      setGenerationError(msg);
      alert(msg);
    } finally {
      isGeneratingRef.current = false;
      setLoading(false);
      setGenerationStageMessage(null);
      setGenerationProgressPercent(null);
    }
  }

  function getCurrentCode() {
    const currentFiles = files[appType];

    const currentFile = currentFiles.find(
      (file) => file.name === selectedFile
    );

    return currentFile?.code || "";
  }

  function updateCurrentCode(code: string) {
    if (!isManualEditingRef.current) {
      isManualEditingRef.current = true;
      pushSnapshot();
    }

    if (manualEditTimerRef.current) {
      clearTimeout(manualEditTimerRef.current);
    }

    manualEditTimerRef.current = setTimeout(() => {
      isManualEditingRef.current = false;
      manualEditTimerRef.current = null;
    }, 1000);

    setFiles((previousFiles) => ({
      ...previousFiles,
      [appType]: previousFiles[appType].map((file) =>
        file.name === selectedFile
          ? {
              ...file,
              code,
            }
          : file
      ),
    }));

    setSaved(false);
  }

  function saveFile() {
    if (manualEditTimerRef.current) {
      clearTimeout(manualEditTimerRef.current);
      manualEditTimerRef.current = null;
    }
    isManualEditingRef.current = false;

    setSaved(true);
    alert("File saved!");
  }

  function saveProject() {
    const existingProject = currentProjectId
      ? savedProjects.find((project) => project.id === currentProjectId)
      : undefined;

    const defaultName = existingProject?.name || `${appType} app`;
    const name = window.prompt("Project name:", defaultName);

    if (!name || !name.trim()) {
      return;
    }

    const payload = {
      name: name.trim(),
      prompt,
      appType,
      files: files[appType],
      dependencies: dependencies[appType],
    };

    if (currentProjectId) {
      const updated = updateProject(currentProjectId, payload);

      if (updated) {
        setSavedProjects(listProjects());
        alert("Project updated!");
        return;
      }
    }

    const created = createProject(payload);
    setCurrentProjectId(created.id);
    setSavedProjects(listProjects());
    alert("Project saved!");
  }

  function openProject(project: SavedProject) {
    setFallbackNotice(null);
    setImproveError(null);
    setImproveSuccess(false);
    setRepairSuccess(null);
    setRepairError(null);
    setRepairDiagnostics([]);
    setRepairOutcome(null);
    pushSnapshot();

    const restoredAppType: AppType = isAppType(project.appType)
      ? project.appType
      : "generic";

    setPrompt(project.prompt);
    setAppType(restoredAppType);

    setFiles((previousFiles) => ({
      ...previousFiles,
      [restoredAppType]: project.files,
    }));

    setDependencies((previousDependencies) => ({
      ...previousDependencies,
      [restoredAppType]: project.dependencies,
    }));

    const hasAppTsx = project.files.some(
      (file) => file.name === "App.tsx"
    );

    setSelectedFile(
      hasAppTsx ? "App.tsx" : project.files[0]?.name || "App.tsx"
    );

    setCurrentProjectId(project.id);
    setSaved(true);
    setShowProjects(false);
    setShowWorkspace(true);
  }

  function deleteSavedProject(id: string) {
    const confirmed = window.confirm("Delete this saved project?");

    if (!confirmed) {
      return;
    }

    deleteProject(id);
    setSavedProjects(listProjects());

    if (currentProjectId === id) {
      setCurrentProjectId(null);
    }
  }

  function renameSavedProject(project: SavedProject) {
    const name = window.prompt("Rename project:", project.name);

    if (!name || !name.trim()) {
      return;
    }

    updateProject(project.id, { name: name.trim() });
    setSavedProjects(listProjects());
  }

  function clearSavedProject() {
    clearActiveWorkspace();
    clearWorkspaceHistory();
    setPastSnapshots([]);
    setFutureSnapshots([]);
    setFallbackNotice(null);
    setImproveError(null);
    setImproveSuccess(false);
    setRepairSuccess(null);
    setRepairError(null);
    setRepairDiagnostics([]);
    setRepairOutcome(null);
    if (currentProjectId) {
      deleteProject(currentProjectId);
      setSavedProjects(listProjects());
      setCurrentProjectId(null);
    }
    setPrompt("");
    setAppType("generic");
    setFiles(defaultFiles);
    setDependencies({
      attendance: {},
      todo: {},
      calculator: {},
      shop: {},
      generic: {},
      });
    setSelectedFile("page.tsx");
    setShowWorkspace(false);
    setSaved(true);
  }

  function startNewProject() {
    clearActiveWorkspace();
    clearWorkspaceHistory();
    setPastSnapshots([]);
    setFutureSnapshots([]);
    setFallbackNotice(null);
    setImproveError(null);
    setImproveSuccess(false);
    setRepairSuccess(null);
    setRepairError(null);
    setRepairDiagnostics([]);
    setRepairOutcome(null);
    setCurrentProjectId(null);
    setPrompt("");
    setShowProjects(false);
    setShowWorkspace(false);
  }

  async function downloadApp() {
    try {
      const currentFiles = files[appType] || [];
      if (currentFiles.length === 0) {
        alert("No files to download.");
        return;
      }

      const zip = new JSZip();

      currentFiles.forEach((file) => {
        if (file && typeof file.name === "string" && typeof file.code === "string") {
          const safeName = file.name.replace(/^(\/|\\)+/, "").replace(/\.\.(\/|\\)+/g, "");
          zip.file(safeName || "file.tsx", file.code);
        }
      });

      const blob = await zip.generateAsync({
        type: "blob",
      });

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = "ai-generated-app.zip";
      link.click();

      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("ZIP download failed:", err);
      alert(
        "Failed to download project ZIP: " +
          (err instanceof Error ? err.message : "Unknown export error")
      );
    }
  }

  function renderPreview() {
    const currentFiles = files[appType] || [];

    if (currentFiles.length === 0) {
      return (
        <div
          style={{
            background: "#141418",
            borderRadius: "12px",
            padding: "40px 20px",
            textAlign: "center",
            color: "#9ca3af",
            minHeight: "300px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <p>No project files available to preview.</p>
        </div>
      );
    }

    const sandpackFiles: Record<string, string> = {};

    currentFiles.forEach((file) => {
      if (!file || typeof file.name !== "string") return;
      const path = file.name.startsWith("/")
        ? file.name
        : `/${file.name}`;

      sandpackFiles[path] = typeof file.code === "string" ? file.code : "";
    });

    const mainFile =
      currentFiles.find((file) => file?.name === "App.tsx") ||
      currentFiles.find((file) => file?.name === "page.tsx") ||
      currentFiles[0];

    if (mainFile && typeof mainFile.code === "string") {
      sandpackFiles["/App.tsx"] = mainFile.code;
    }

    sandpackFiles["/index.tsx"] = `
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;

    sandpackFiles["/public/index.html"] = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI App Preview</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

    const currentDeps = dependencies[appType] || {};

    return (
      <div className="w-full min-h-[560px] h-full rounded-xl overflow-hidden bg-[#18181c]">
        <PreviewErrorBoundary onRepair={repairApp} isBusy={isBusy}>
          <SandpackProvider
            key={`${appType}-${mainFile?.name}-${mainFile?.code}-${JSON.stringify(
              currentDeps
            )}`}
            template="react-ts"
            files={sandpackFiles}
            customSetup={{
              dependencies: currentDeps,
            }}
            options={{
              bundlerURL: "/sandpack",
            }}
            theme="dark"
          >
            <SandpackLayout
              style={{
                border: "none",
                borderRadius: 0,
                height: "100%",
                minHeight: "560px",
                background: "transparent",
              }}
            >
              <SandpackPreview
                showNavigator={false}
                showOpenInCodeSandbox={false}
                showRefreshButton={true}
                showRestartButton={true}
                showSandpackErrorOverlay={true}
                style={{
                  height: "100%",
                  minHeight: "560px",
                  width: "100%",
                }}
              />
            </SandpackLayout>
          </SandpackProvider>
        </PreviewErrorBoundary>
      </div>
    );
  }

  const currentStageIndex = getStageIndex(generationStageMessage);

  return (
    <div className="min-h-screen flex flex-col bg-[#0d0f12] text-[#ededed] font-sans selection:bg-[#168bff]/30 selection:text-white">
      {/* GLOBAL META AI TOP BAR */}
      <header className="w-full border-b border-[#202026] bg-[#0d0f12]/95 backdrop-blur-md sticky top-0 z-50 px-4 sm:px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <MetaEmblem size={30} animated={false} />
          <MetaWordmark />
          <span className="hidden sm:inline-block text-xs uppercase tracking-widest text-[#71717a] font-medium pl-3 border-l border-[#27272f]">
            App Builder
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Active Model Pill */}
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-[#16161b] text-[#e4e4e7] border border-[#262630]">
            <span className="w-2 h-2 rounded-full bg-[#168bff] shadow-[0_0_8px_#168bff]" />
            <span className="font-mono text-[11px] text-[#38bdf8]">Meta Muse Spark 1.3</span>
          </div>

          {showWorkspace ? (
            <button
              onClick={startNewProject}
              disabled={isBusy}
              className="text-xs px-3.5 py-1.5 rounded-lg border border-[#33333d] bg-[#1a1a20] text-white hover:bg-[#25252c] transition flex items-center gap-1.5 disabled:opacity-50"
            >
              <span>+</span>
              <span>New App</span>
            </button>
          ) : (
            <button
              onClick={() => setShowProjects(!showProjects)}
              disabled={isBusy}
              className="text-xs px-3.5 py-1.5 rounded-lg border border-[#33333d] bg-[#1a1a20] text-white hover:bg-[#25252c] transition flex items-center gap-1.5 disabled:opacity-50"
            >
              <span>📂</span>
              <span>My Projects</span>
              {savedProjects.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-[#27272f] text-[#a1a1aa] font-mono">
                  {savedProjects.length}
                </span>
              )}
            </button>
          )}
        </div>
      </header>

      {/* MAIN CONTENT ROUTE */}
      <main className="flex-1 flex flex-col p-4 sm:p-6 lg:p-8 max-w-[1680px] w-full mx-auto">
        {!showWorkspace && showProjects ? (
          /* ======================================================== */
          /* 1. PROJECTS DASHBOARD                                    */
          /* ======================================================== */
          <div className="max-w-5xl w-full mx-auto pt-6">
            <div className="flex items-center justify-between mb-8 pb-4 border-b border-[#222228] flex-wrap gap-4">
              <div>
                <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                  <span>📂</span>
                  <span>Projects Dashboard</span>
                </h1>
                <p className="text-xs text-[#71717a] mt-1">
                  Manage your saved Meta AI App Builder projects
                </p>
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  onClick={startNewProject}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-[#16a34a] hover:bg-[#15803d] text-white transition flex items-center gap-1.5 shadow-sm"
                >
                  <span>+</span>
                  <span>New Project</span>
                </button>
                <button
                  onClick={() => setShowProjects(false)}
                  className="px-4 py-2 rounded-xl text-xs font-medium border border-[#33333d] bg-[#1a1a20] text-white hover:bg-[#25252c] transition"
                >
                  ← Back to Generator
                </button>
              </div>
            </div>

            {savedProjects.length === 0 ? (
              <div className="text-center py-20 border border-dashed border-[#26262e] rounded-2xl bg-[#141418]">
                <div className="w-12 h-12 rounded-full bg-[#1e1e26] text-[#71717a] flex items-center justify-center mx-auto mb-3 text-xl">
                  📁
                </div>
                <p className="text-sm text-[#a1a1aa] mb-2 font-medium">No saved projects yet</p>
                <p className="text-xs text-[#71717a] max-w-sm mx-auto mb-6">
                  Generate an application with Meta AI, then click &quot;Save Project&quot; in the workspace.
                </p>
                <button
                  onClick={() => setShowProjects(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-[#168bff] text-white hover:bg-[#0072ff] transition"
                >
                  Create Your First App
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {savedProjects.map((project) => (
                  <div
                    key={project.id}
                    className="p-5 rounded-2xl bg-[#16161b] border border-[#262630] hover:border-[#383848] transition-all flex flex-col justify-between shadow-sm group"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <h3 className="font-semibold text-white text-base truncate group-hover:text-[#38bdf8] transition">
                          {project.name}
                        </h3>
                        <span className="shrink-0 px-2.5 py-0.5 rounded-full bg-[#22222a] text-[#a1a1aa] text-[11px] font-mono capitalize border border-[#2c2c36]">
                          {project.appType}
                        </span>
                      </div>

                      <p className="text-xs text-[#a1a1aa] line-clamp-3 mb-4 leading-relaxed">
                        {project.prompt}
                      </p>
                    </div>

                    <div>
                      <div className="text-[11px] text-[#52525b] mb-4 font-mono">
                        Updated {new Date(project.updatedAt).toLocaleDateString()} at{" "}
                        {new Date(project.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>

                      <div className="flex items-center gap-2 pt-3 border-t border-[#202026]">
                        <button
                          onClick={() => openProject(project)}
                          className="flex-1 py-1.5 rounded-lg text-xs font-medium bg-[#168bff] hover:bg-[#0072ff] text-white transition text-center shadow-sm"
                        >
                          Open Studio
                        </button>
                        <button
                          onClick={() => renameSavedProject(project)}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[#33333d] bg-[#1a1a20] text-[#d4d4d8] hover:text-white hover:bg-[#25252c] transition"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => deleteSavedProject(project.id)}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[#3f1d24] bg-[#221316] text-[#f87171] hover:bg-[#38161c] transition"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : !showWorkspace ? (
          /* ======================================================== */
          /* 2. META AI-INSPIRED HOMEPAGE                             */
          /* ======================================================== */
          <div className="max-w-4xl w-full mx-auto my-auto text-center py-10 sm:py-14 flex flex-col items-center">
            {/* Center Animated Meta Symbol */}
            <div className="mb-6 relative">
              <MetaEmblem size={78} animated={true} />
            </div>

            {/* Hero Headlines */}
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-white mb-2 leading-tight">
              Imagine it. Build it.
            </h1>

            <p className="text-2xl sm:text-3xl font-semibold mb-4 text-[#168bff] tracking-tight">
              Your ideas, transformed into apps.
            </p>

            <p className="text-sm sm:text-base text-[#a1a1aa] max-w-lg mx-auto mb-8 font-normal leading-relaxed">
              Describe your application and let Meta AI bring it to life with full-stack TypeScript and interactive preview.
            </p>

            {/* Error Banner if any */}
            {generationError && (
              <div className="w-full max-w-2xl mb-6 p-4 rounded-xl bg-[#2b1216] border border-[#ef4444]/40 text-[#fca5a5] text-xs sm:text-sm flex items-center justify-between text-left shadow-lg">
                <div className="flex items-center gap-2">
                  <span className="text-base">⚠️</span>
                  <span>{generationError}</span>
                </div>
                <button
                  onClick={() => setGenerationError(null)}
                  className="text-[#fca5a5] hover:text-white font-bold px-2 py-1 text-sm"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Large Rounded Dark Prompt Composer */}
            <div className="w-full max-w-2xl rounded-3xl bg-[#1e1e23] border border-[#33333d] hover:border-[#42424e] focus-within:border-[#168bff] focus-within:ring-2 focus-within:ring-[#168bff]/20 transition-all p-4 sm:p-5 shadow-2xl relative text-left">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                disabled={isBusy}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && prompt.trim() && !isBusy) {
                    e.preventDefault();
                    generateApp();
                  }
                }}
                placeholder="Ask Meta AI anything... (e.g. Build an analytics dashboard with real-time revenue metrics, interactive charts, and transactions table)"
                className="w-full min-h-[110px] bg-transparent text-white placeholder-[#71717a] text-sm sm:text-base resize-none focus:outline-none leading-relaxed"
              />

              {/* Composer Bottom Row */}
              <div className="flex items-center justify-between pt-3 border-t border-[#292932] mt-2">
                <div className="flex items-center gap-2.5 text-xs text-[#71717a]">
                  <span className="w-6 h-6 rounded-full flex items-center justify-center bg-[#292934] text-[#a1a1aa] text-xs font-bold">
                    +
                  </span>
                  <span className="hidden sm:inline font-medium text-[#a1a1aa]">Powered by Meta AI</span>
                  {prompt.length > 0 && (
                    <span className="font-mono text-[11px] text-[#52525b]">
                      {prompt.length} / {MAX_PROMPT_LENGTH}
                    </span>
                  )}
                </div>

                <button
                  onClick={generateApp}
                  disabled={isBusy || !prompt.trim()}
                  aria-label="Generate App with Meta AI"
                  className="w-10 h-10 rounded-full flex items-center justify-center transition-all bg-[#168bff] hover:bg-[#0072ff] active:scale-95 disabled:opacity-40 disabled:pointer-events-none text-white shadow-[0_0_16px_rgba(22,139,255,0.4)]"
                >
                  {loading ? (
                    <svg className="animate-spin h-5 w-5 text-white" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="19" x2="12" y2="5" />
                      <polyline points="5 12 12 5 19 12" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Quick-Start Prompt Chips */}
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2 max-w-2xl">
              {QUICK_PROMPTS.map((item, idx) => (
                <button
                  key={idx}
                  onClick={() => setPrompt(item.fullPrompt)}
                  disabled={isBusy}
                  className="text-xs px-3.5 py-1.5 rounded-full border border-[#2b2b35] bg-[#18181d] text-[#d4d4d8] hover:border-[#168bff]/60 hover:text-white hover:bg-[#22222a] transition flex items-center gap-1.5 shadow-sm"
                >
                  <span>{item.icon}</span>
                  <span>{item.title}</span>
                </button>
              ))}
            </div>

            {/* Live Staged Generation Progress Bar & Indicator */}
            {loading && (
              <div className="mt-8 w-full max-w-2xl p-5 rounded-2xl bg-[#15151a] border border-[#262632] shadow-2xl text-left">
                {/* Visual Stage Pipeline */}
                <div className="grid grid-cols-5 gap-2 mb-4">
                  {PIPELINE_STAGES.map((stage, idx) => {
                    const isDone = currentStageIndex > idx;
                    const isCurrent = currentStageIndex === idx;
                    return (
                      <div
                        key={stage.id}
                        className={`p-2 rounded-xl border text-center transition ${
                          isDone
                            ? "border-[#10b981]/50 bg-[#064e3b]/30 text-[#6ee7b7]"
                            : isCurrent
                            ? "border-[#168bff] bg-[#1e3a8a]/40 text-[#93c5fd] shadow-[0_0_12px_rgba(22,139,255,0.25)]"
                            : "border-[#27272f] bg-[#191920] text-[#71717a]"
                        }`}
                      >
                        <div className="text-[10px] font-mono uppercase tracking-wider mb-0.5">
                          {isDone ? "✓ Done" : isCurrent ? "● Active" : `Step ${idx + 1}`}
                        </div>
                        <div className="text-[11px] font-medium truncate">{stage.name}</div>
                      </div>
                    );
                  })}
                </div>

                {/* Animated Gradient Progress Bar */}
                <div className="w-full bg-[#24242e] rounded-full h-2 mb-3 overflow-hidden">
                  <div
                    className="bg-gradient-to-r from-[#168bff] via-[#a855f7] to-[#ec4899] h-2 rounded-full transition-all duration-300"
                    style={{
                      width: `${generationProgressPercent ?? Math.min(95, Math.max(12, generationElapsed * 3.5))}%`,
                    }}
                  />
                </div>

                {/* Status Message and Elapsed Time */}
                <div className="flex items-center justify-between text-xs text-[#93c5fd]">
                  <div className="flex items-center gap-2">
                    <svg className="animate-spin h-3.5 w-3.5 text-[#168bff]" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                    <span>{getGenerationProgressMessage()}</span>
                  </div>
                  <span className="font-mono text-[#a1a1aa] text-[11px] bg-[#202028] px-2 py-0.5 rounded">
                    {generationElapsed}s
                  </span>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* ======================================================== */
          /* 3. GENERATION WORKSPACE (STUDIO)                         */
          /* ======================================================== */
          <div className="w-full flex flex-col flex-1">
            {/* ALERTS */}
            {generationError && (
              <div className="p-3.5 rounded-xl bg-[#2b1216] text-[#fca5a5] border border-[#ef4444]/40 text-xs mb-4 flex items-center justify-between">
                <span>⚠️ {generationError}</span>
                <button onClick={() => setGenerationError(null)} className="font-bold text-sm px-2">✕</button>
              </div>
            )}

            {fallbackNotice && (
              <div className="p-3.5 rounded-xl bg-[#0c2340] text-[#93c5fd] border border-[#3b82f6]/40 text-xs mb-4 flex items-center justify-between">
                <span>ℹ️ {fallbackNotice}</span>
                <button onClick={() => setFallbackNotice(null)} className="font-bold text-sm px-2">✕</button>
              </div>
            )}

            {improveError && (
              <div className="p-3.5 rounded-xl bg-[#2b1216] text-[#fca5a5] border border-[#ef4444]/40 text-xs mb-4 flex items-center justify-between">
                <span>⚠️ {improveError}</span>
                <button onClick={() => setImproveError(null)} className="font-bold text-sm px-2">✕</button>
              </div>
            )}

            {improveSuccess && (
              <div className="p-3.5 rounded-xl bg-[#062c20] text-[#6ee7b7] border border-[#10b981]/40 text-xs mb-4 flex items-center justify-between">
                <span>✓ Application improvements successfully applied!</span>
                <button onClick={() => setImproveSuccess(false)} className="font-bold text-sm px-2">✕</button>
              </div>
            )}

            {repairSuccess && (
              <div className="p-3.5 rounded-xl bg-[#062c20] text-[#6ee7b7] border border-[#10b981]/40 text-xs mb-4 flex items-center justify-between">
                <div>
                  <span className="font-medium">{repairSuccess}</span>
                  {repairOutcome && <p className="text-[11px] text-[#a7f3d0] mt-0.5">{repairOutcome}</p>}
                </div>
                <button onClick={() => setRepairSuccess(null)} className="font-bold text-sm px-2">✕</button>
              </div>
            )}

            {(repairError || repairDiagnostics.length > 0) && (
              <div className="p-4 rounded-xl bg-[#2b1216] text-[#fca5a5] border border-[#ef4444]/40 text-xs mb-4">
                <div className="flex items-start justify-between">
                  <div>
                    <span className="font-semibold">⚠️ {repairError || "Syntax diagnostics detected in workspace"}</span>
                    {repairOutcome && repairOutcome !== repairError && (
                      <p className="mt-1 text-[11px] text-[#fca5a5]">{repairOutcome}</p>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setRepairError(null);
                      setRepairDiagnostics([]);
                      setRepairOutcome(null);
                    }}
                    className="font-bold text-sm px-2"
                  >
                    ✕
                  </button>
                </div>

                {repairDiagnostics.length > 0 && (
                  <div className="mt-2.5">
                    <p className="text-[11px] font-semibold text-[#fecaca] mb-1">
                      Diagnostics ({repairDiagnostics.length}):
                    </p>
                    <div className="max-h-36 overflow-y-auto bg-[#181112] p-2.5 rounded-lg font-mono text-[11px]">
                      {repairDiagnostics.map((diag, idx) => (
                        <div key={idx} className="mb-1.5 pb-1 border-b border-[#2d1b1d] last:border-b-0 last:mb-0">
                          <span className="text-[#38bdf8]">{diag.path}</span>
                          {diag.line ? `:${diag.line}:${diag.character || 1}` : ""}:{" "}
                          <span className="text-[#f87171]">{diag.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* WORKSPACE HEADER TOOLBAR */}
            <div className="flex items-center justify-between gap-4 pb-4 mb-4 border-b border-[#202026] flex-wrap">
              <div className="min-w-0 max-w-xl">
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-base sm:text-lg font-bold text-white truncate">
                    {prompt ? prompt.slice(0, 60) : "Meta AI Workspace"}
                    {prompt && prompt.length > 60 ? "..." : ""}
                  </h2>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#16161b] text-[#38bdf8] border border-[#272733] font-mono shrink-0">
                    Meta Muse Spark 1.3
                  </span>
                </div>
                {loading && (
                  <div className="flex items-center gap-2 text-xs text-[#60a5fa] animate-pulse">
                    <svg className="animate-spin h-3.5 w-3.5 text-[#168bff]" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                    <span>{getGenerationProgressMessage()}</span>
                  </div>
                )}
              </div>

              {/* Action Toolbar */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={regenerateApp}
                  disabled={isBusy}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium bg-[#1a1a20] border border-[#2f2f3d] text-white hover:bg-[#252530] transition flex items-center gap-1.5 disabled:opacity-50"
                >
                  <span>🔄</span>
                  <span>{loading ? `Regenerating (${generationElapsed}s)` : "Regenerate"}</span>
                </button>

                <button
                  onClick={improveApp}
                  disabled={isBusy}
                  aria-label="AI Improve"
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-gradient-to-r from-[#7c3aed] to-[#9333ea] text-white hover:opacity-90 transition flex items-center gap-1.5 disabled:opacity-50 shadow-sm"
                >
                  <span>✨</span>
                  <span>{improveLoading ? "Improving..." : "AI Improve"}</span>
                </button>

                <button
                  onClick={repairApp}
                  disabled={isBusy}
                  aria-label="Repair errors"
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-gradient-to-r from-[#0d9488] to-[#059669] text-white hover:opacity-90 transition flex items-center gap-1.5 disabled:opacity-50 shadow-sm"
                >
                  <span>🛠️</span>
                  <span>{repairLoading ? "Repairing..." : "Repair errors"}</span>
                </button>

                <div className="flex items-center border border-[#272733] rounded-xl overflow-hidden bg-[#16161b]">
                  <button
                    onClick={undo}
                    disabled={pastSnapshots.length === 0 || isBusy}
                    aria-label="Undo"
                    className="px-2.5 py-1.5 text-xs text-[#a1a1aa] hover:text-white hover:bg-[#22222a] disabled:opacity-40 disabled:hover:bg-transparent transition"
                  >
                    ↩ Undo
                  </button>
                  <div className="w-[1px] h-4 bg-[#272733]" />
                  <button
                    onClick={redo}
                    disabled={futureSnapshots.length === 0 || isBusy}
                    aria-label="Redo"
                    className="px-2.5 py-1.5 text-xs text-[#a1a1aa] hover:text-white hover:bg-[#22222a] disabled:opacity-40 disabled:hover:bg-transparent transition"
                  >
                    ↪ Redo
                  </button>
                </div>

                <button
                  onClick={saveProject}
                  disabled={isBusy}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium bg-[#16a34a] hover:bg-[#15803d] text-white transition flex items-center gap-1.5 disabled:opacity-50"
                >
                  <span>💾</span>
                  <span>Save</span>
                </button>

                {currentProjectId && (
                  <button
                    onClick={clearSavedProject}
                    disabled={isBusy}
                    className="px-3 py-1.5 rounded-xl text-xs font-medium border border-[#3f1d24] bg-[#221316] text-[#f87171] hover:bg-[#38161c] transition flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <span>🗑️</span>
                    <span>Clear Saved</span>
                  </button>
                )}
                <button
                  onClick={downloadApp}
                  disabled={isBusy}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium bg-[#168bff] hover:bg-[#0072ff] text-white transition flex items-center gap-1.5 disabled:opacity-50"
                >
                  <span>📦</span>
                  <span>ZIP</span>
                </button>

                <button
                  onClick={startNewProject}
                  disabled={isBusy}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium bg-[#22222a] text-[#a1a1aa] hover:text-white hover:bg-[#2c2c36] transition"
                >
                  + New App
                </button>
              </div>
            </div>

            {/* STUDIO 3-COLUMN LAYOUT */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 flex-1">
              {/* COLUMN 1: FILES EXPLORER */}
              <div className="lg:col-span-2 bg-[#141418] border border-[#22222a] rounded-2xl p-4 flex flex-col shadow-sm">
                <div className="flex items-center justify-between pb-3 mb-3 border-b border-[#22222a]">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[#71717a] flex items-center gap-1.5">
                    <span>📁</span> Files
                  </h3>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#1e1e26] text-[#a1a1aa]">
                    {(files[appType] || []).length}
                  </span>
                </div>

                <div className="space-y-1 overflow-y-auto flex-1">
                  {(files[appType] || []).map((file) => (
                    <button
                      key={file.name}
                      onClick={() => setSelectedFile(file.name)}
                      disabled={isBusy}
                      className={`w-full text-left px-3 py-2 rounded-xl text-xs font-mono flex items-center justify-between transition ${
                        selectedFile === file.name
                          ? "bg-[#168bff]/15 text-[#38bdf8] border border-[#168bff]/30"
                          : "text-[#a1a1aa] hover:bg-[#1e1e26] hover:text-white"
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span>
                          {file.name.endsWith(".tsx") ? "⚛️" : file.name.endsWith(".ts") ? "🔷" : "📄"}
                        </span>
                        <span className="truncate">{file.name}</span>
                      </div>
                      {file.name === "App.tsx" && (
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-[#168bff]/20 text-[#60a5fa] font-sans shrink-0">
                          main
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* COLUMN 2: AI EDIT + CODE EDITOR */}
              <div className="lg:col-span-5 flex flex-col gap-4">
                {/* AI Edit Drawer (Pure Meta) */}
                <div className="bg-[#141418] border border-[#22222a] rounded-2xl p-4 shadow-sm">
                  <div className="flex items-center justify-between mb-2.5 flex-wrap gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                      <span>✨</span>
                      <span>Meta AI Edit</span>
                    </div>
                    <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono bg-[#1c1c24] text-[#38bdf8] border border-[#282834]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#168bff]" />
                      muse-spark-1.3
                    </div>
                  </div>

                  <textarea
                    value={editInstruction}
                    onChange={(e) => setEditInstruction(e.target.value)}
                    disabled={isBusy}
                    placeholder="Describe edits (e.g. 'Add dark mode toggle button in header', 'Add search filter to products table')..."
                    className="w-full min-h-[72px] bg-[#0d0f12] border border-[#252530] focus:border-[#168bff] rounded-xl p-3 text-xs text-white placeholder-[#71717a] resize-y focus:outline-none leading-relaxed"
                  />

                  <div className="flex items-center justify-between mt-2.5 flex-wrap gap-2">
                    <button
                      onClick={applyEdit}
                      disabled={isBusy || !editInstruction.trim()}
                      className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-gradient-to-r from-[#168bff] to-[#2563eb] hover:from-[#0072ff] hover:to-[#1d4ed8] text-white shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-1.5"
                    >
                      {editLoading ? (
                        <>
                          <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                          </svg>
                          <span>Applying changes...</span>
                        </>
                      ) : (
                        <span>Apply Changes</span>
                      )}
                    </button>
                    {editSuccess && (
                      <span className="text-xs text-[#34d399] font-medium flex items-center gap-1">
                        ✓ Changes applied
                      </span>
                    )}
                    {editError && (
                      <span className="text-xs text-[#f87171] font-medium">
                        ⚠️ {editError}
                      </span>
                    )}
                  </div>
                </div>

                {/* Generated Code Editor */}
                <div className="bg-[#141418] border border-[#22222a] rounded-2xl p-4 flex flex-col flex-1 shadow-sm">
                  <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-[#22222a]">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-[#38bdf8] bg-[#168bff]/10 px-2 py-0.5 rounded border border-[#168bff]/20">
                        {selectedFile}
                      </span>
                      <span className="text-[11px] text-[#71717a]">
                        {(getCurrentCode().match(/\n/g) || []).length + 1} lines
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={saveFile}
                        disabled={isBusy}
                        className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                          saved
                            ? "bg-[#22222a] text-[#a1a1aa] hover:bg-[#2c2c36]"
                            : "bg-[#10b981] text-white shadow-sm hover:bg-[#059669]"
                        }`}
                      >
                        {saved ? "Saved" : "Save"}
                      </button>
                      <button
                        onClick={downloadApp}
                        disabled={isBusy}
                        className="px-3 py-1 rounded-lg text-xs font-medium bg-[#1e293b] text-[#93c5fd] border border-[#334155] hover:bg-[#334155] transition"
                      >
                        Export
                      </button>
                    </div>
                  </div>

                  <textarea
                    value={getCurrentCode()}
                    readOnly={isBusy}
                    onChange={(event) => updateCurrentCode(event.target.value)}
                    onBlur={() => {
                      if (manualEditTimerRef.current) {
                        clearTimeout(manualEditTimerRef.current);
                        manualEditTimerRef.current = null;
                      }
                      isManualEditingRef.current = false;
                    }}
                    spellCheck={false}
                    className="flex-1 w-full min-h-[480px] bg-[#0d0f12] text-[#e4e4e7] border border-[#22222a] rounded-xl p-3.5 font-mono text-xs leading-relaxed resize-none focus:outline-none focus:border-[#168bff]"
                  />
                </div>
              </div>

              {/* COLUMN 3: LIVE PREVIEW */}
              <div className="lg:col-span-5 bg-[#141418] border border-[#22222a] rounded-2xl p-4 flex flex-col shadow-sm">
                <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-[#22222a]">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-[#71717a] flex items-center gap-1.5">
                      <span>👀</span> Live Preview
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#168bff]/15 text-[#38bdf8] font-mono border border-[#168bff]/30">
                      React + TS
                    </span>
                  </div>
                  <span className="text-[11px] text-[#71717a]">Live App Preview</span>
                </div>

                <div className="flex-1 rounded-xl overflow-hidden border border-[#22222a] bg-black">
                  {renderPreview()}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
