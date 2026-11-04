"use client";

import { useState, useRef, useEffect, Component, type ReactNode, type ErrorInfo } from "react";
import { Sandpack } from "@codesandbox/sandpack-react";
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
  AVAILABLE_PROVIDERS,
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

  const [selectedProvider, setSelectedProvider] = useState<ModelProviderType>("meta");
  const [selectedModel, setSelectedModel] = useState<string>("muse-spark-1.3");

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

  function handleProviderChange(newProvider: ModelProviderType) {
    setSelectedProvider(newProvider);
    const providerConfig = AVAILABLE_PROVIDERS.find((p) => p.provider === newProvider);
    const defaultModel =
      providerConfig?.models.find((m) => m.isDefault)?.id ||
      providerConfig?.models[0]?.id ||
      "";
    setSelectedModel(defaultModel);
  }

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
        const maxPollAttempts = 300;
        let consecutiveNetworkErrors = 0;

        while (!jobCompleted && pollAttempts < maxPollAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
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

          let pollData: Record<string, unknown>;
          try {
            pollData = JSON.parse(pollText);
          } catch {
            continue;
          }

          if (!pollRes.ok || pollData.success === false) {
            throw new Error(
              typeof pollData.message === "string"
                ? pollData.message
                : typeof pollData.error === "string"
                ? pollData.error
                : `Generation failed (HTTP ${pollRes.status}).`
            );
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
        const maxPollAttempts = 300;
        let consecutiveNetworkErrors = 0;

        while (!jobCompleted && pollAttempts < maxPollAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
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

          let pollData: Record<string, unknown>;
          try {
            pollData = JSON.parse(pollText);
          } catch {
            continue;
          }

          if (!pollRes.ok || pollData.success === false) {
            throw new Error(
              typeof pollData.message === "string"
                ? pollData.message
                : typeof pollData.error === "string"
                ? pollData.error
                : `Generation failed (HTTP ${pollRes.status}).`
            );
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
            background: "white",
            borderRadius: "12px",
            padding: "40px 20px",
            textAlign: "center",
            color: "#6b7280",
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
      <div
        style={{
          background: "white",
          borderRadius: "12px",
          overflow: "hidden",
          minHeight: "560px",
        }}
      >
        <PreviewErrorBoundary onRepair={repairApp} isBusy={isBusy}>
          <Sandpack
            key={`${appType}-${mainFile?.name}-${mainFile?.code}-${JSON.stringify(
              currentDeps
            )}`}
            template="react-ts"
            files={sandpackFiles}
            customSetup={{
              dependencies: currentDeps,
            }}
            options={{
              showTabs: false,
              showNavigator: false,
              showConsole: true,
              bundlerURL: "/sandpack",
            }}
          />
        </PreviewErrorBoundary>
      </div>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#111827",
        color: "white",
        padding: "30px",
      }}
    >
      {!showWorkspace && showProjects ? (
        <div
          style={{
            maxWidth: "1100px",
            margin: "0 auto",
            paddingTop: "60px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "30px",
              flexWrap: "wrap",
              gap: "12px",
            }}
          >
            <h1 style={{ fontSize: "32px" }}>📂 Projects Dashboard</h1>

            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={startNewProject}
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "none",
                  background: "#16a34a",
                  color: "white",
                  cursor: "pointer",
                }}
              >
                + New Project
              </button>

              <button
                onClick={() => setShowProjects(false)}
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "1px solid #374151",
                  background: "#1f2937",
                  color: "white",
                  cursor: "pointer",
                }}
              >
                ← Back
              </button>
            </div>
          </div>

          {savedProjects.length === 0 ? (
            <p style={{ color: "#9ca3af" }}>
              No saved projects yet. Generate an app, then use &quot;Save
              Project&quot; to see it here.
            </p>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                gap: "16px",
              }}
            >
              {savedProjects.map((project) => (
                <div
                  key={project.id}
                  style={{
                    background: "#1f2937",
                    borderRadius: "12px",
                    padding: "18px",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: "8px",
                      marginBottom: "6px",
                    }}
                  >
                    <h3 style={{ wordBreak: "break-word" }}>
                      {project.name}
                    </h3>

                    <span
                      style={{
                        flexShrink: 0,
                        padding: "3px 10px",
                        borderRadius: "999px",
                        background: "#374151",
                        color: "#cbd5e1",
                        fontSize: "12px",
                        textTransform: "capitalize",
                      }}
                    >
                      {project.appType}
                    </span>
                  </div>

                  <p
                    style={{
                      color: "#9ca3af",
                      fontSize: "14px",
                      marginBottom: "6px",
                      flexGrow: 1,
                    }}
                  >
                    {project.prompt}
                  </p>

                  <p
                    style={{
                      color: "#6b7280",
                      fontSize: "12px",
                      marginBottom: "12px",
                    }}
                  >
                    Updated {new Date(project.updatedAt).toLocaleString()}
                  </p>

                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      flexWrap: "wrap",
                    }}
                  >
                    <button
                      onClick={() => openProject(project)}
                      style={{
                        padding: "8px 14px",
                        borderRadius: "6px",
                        border: "none",
                        background: "#2563eb",
                        color: "white",
                        cursor: "pointer",
                      }}
                    >
                      Open
                    </button>

                    <button
                      onClick={() => renameSavedProject(project)}
                      style={{
                        padding: "8px 14px",
                        borderRadius: "6px",
                        border: "1px solid #374151",
                        background: "transparent",
                        color: "white",
                        cursor: "pointer",
                      }}
                    >
                      Rename
                    </button>

                    <button
                      onClick={() => deleteSavedProject(project.id)}
                      style={{
                        padding: "8px 14px",
                        borderRadius: "6px",
                        border: "1px solid #374151",
                        background: "transparent",
                        color: "#f87171",
                        cursor: "pointer",
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : !showWorkspace ? (
        <div
          style={{
            maxWidth: "900px",
            margin: "0 auto",
            textAlign: "center",
            paddingTop: "100px",
          }}
        >
          <h1
            style={{
              fontSize: "48px",
              marginBottom: "15px",
            }}
          >
            AI App Builder
          </h1>

          <p
            style={{
              fontSize: "18px",
              color: "#cbd5e1",
              marginBottom: "40px",
            }}
          >
            Describe the application you want to build.
          </p>

          {generationError && (
            <div
              style={{
                background: "#450a0a",
                color: "#fca5a5",
                padding: "12px 16px",
                borderRadius: "8px",
                marginBottom: "20px",
                border: "1px solid #ef4444",
                fontSize: "14px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                textAlign: "left",
              }}
            >
              <span>⚠️ {generationError}</span>
              <button
                onClick={() => setGenerationError(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#fca5a5",
                  cursor: "pointer",
                  fontWeight: "bold",
                  fontSize: "16px",
                }}
              >
                ✕
              </button>
            </div>
          )}

          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={isBusy}
            placeholder="Example: Build me a todo app with an input box and Add button..."
            style={{
              width: "100%",
              minHeight: "160px",
              padding: "18px",
              borderRadius: "12px",
              border: "1px solid #374151",
              background: "#1f2937",
              color: "white",
              fontSize: "16px",
              resize: "vertical",
              opacity: isBusy ? 0.7 : 1,
            }}
          />

          <div
            style={{
              display: "flex",
              gap: "16px",
              justifyContent: "center",
              marginTop: "16px",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <label htmlFor="provider-select" style={{ fontSize: "14px", color: "#cbd5e1" }}>
                Provider:
              </label>
              <select
                id="provider-select"
                value={selectedProvider}
                disabled={isBusy}
                onChange={(e) => handleProviderChange(e.target.value as ModelProviderType)}
                style={{
                  padding: "8px 12px",
                  borderRadius: "8px",
                  border: "1px solid #374151",
                  background: "#1f2937",
                  color: "white",
                  fontSize: "14px",
                  cursor: isBusy ? "not-allowed" : "pointer",
                }}
              >
                {AVAILABLE_PROVIDERS.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <label htmlFor="model-select" style={{ fontSize: "14px", color: "#cbd5e1" }}>
                Model:
              </label>
              <select
                id="model-select"
                value={selectedModel}
                disabled={isBusy}
                onChange={(e) => setSelectedModel(e.target.value)}
                style={{
                  padding: "8px 12px",
                  borderRadius: "8px",
                  border: "1px solid #374151",
                  background: "#1f2937",
                  color: "white",
                  fontSize: "14px",
                  cursor: isBusy ? "not-allowed" : "pointer",
                }}
              >
                {AVAILABLE_PROVIDERS.find((p) => p.provider === selectedProvider)?.models.map(
                  (m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  )
                )}
              </select>
            </div>
          </div>

          <div
            style={{
              marginTop: "20px",
              display: "flex",
              gap: "12px",
              justifyContent: "center",
            }}
          >
            <button
              onClick={generateApp}
              disabled={isBusy}
              style={{
                padding: "14px 28px",
                borderRadius: "10px",
                border: "none",
                background: isBusy ? "#4b5563" : "#2563eb",
                color: "white",
                fontSize: "16px",
                cursor: isBusy ? "not-allowed" : "pointer",
              }}
            >
              {loading ? `Generating... (${generationElapsed}s)` : "Generate App"}
            </button>

            <button
              onClick={() => setShowProjects(true)}
              disabled={isBusy}
              style={{
                padding: "14px 28px",
                borderRadius: "10px",
                border: "1px solid #374151",
                background: "#1f2937",
                color: "white",
                fontSize: "16px",
                cursor: isBusy ? "not-allowed" : "pointer",
                opacity: isBusy ? 0.6 : 1,
              }}
            >
              📂 My Projects
            </button>
          </div>

          {loading && (
            <div
              style={{
                marginTop: "16px",
                padding: "12px 20px",
                borderRadius: "8px",
                background: "rgba(30, 41, 59, 0.85)",
                border: "1px solid #334155",
                color: "#93c5fd",
                fontSize: "14px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "10px",
              }}
            >
              <span style={{ fontSize: "16px" }}>⏳</span>
              <span>{getGenerationProgressMessage()}</span>
            </div>
          )}
        </div>
      ) : (
        <div>
          {generationError && (
            <div
              style={{
                background: "#450a0a",
                color: "#fca5a5",
                padding: "10px 16px",
                borderRadius: "8px",
                marginBottom: "20px",
                border: "1px solid #ef4444",
                fontSize: "14px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>⚠️ {generationError}</span>
              <button
                onClick={() => setGenerationError(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#fca5a5",
                  cursor: "pointer",
                  fontWeight: "bold",
                  fontSize: "16px",
                }}
              >
                ✕
              </button>
            </div>
          )}

          {fallbackNotice && (
            <div
              style={{
                background: "#1e3a8a",
                color: "#93c5fd",
                padding: "10px 16px",
                borderRadius: "8px",
                marginBottom: "20px",
                border: "1px solid #3b82f6",
                fontSize: "14px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>ℹ️ {fallbackNotice}</span>
              <button
                onClick={() => setFallbackNotice(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#93c5fd",
                  cursor: "pointer",
                  fontWeight: "bold",
                  fontSize: "16px",
                }}
              >
                ✕
              </button>
            </div>
          )}

          {improveError && (
            <div
              style={{
                background: "#450a0a",
                color: "#fca5a5",
                padding: "10px 16px",
                borderRadius: "8px",
                marginBottom: "20px",
                border: "1px solid #ef4444",
                fontSize: "14px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>⚠️ {improveError}</span>
              <button
                onClick={() => setImproveError(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#fca5a5",
                  cursor: "pointer",
                  fontWeight: "bold",
                  fontSize: "16px",
                }}
              >
                ✕
              </button>
            </div>
          )}

          {improveSuccess && (
            <div
              style={{
                background: "#064e3b",
                color: "#6ee7b7",
                padding: "10px 16px",
                borderRadius: "8px",
                marginBottom: "20px",
                border: "1px solid #10b981",
                fontSize: "14px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>✓ Application improvements successfully applied!</span>
              <button
                onClick={() => setImproveSuccess(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#6ee7b7",
                  cursor: "pointer",
                  fontWeight: "bold",
                  fontSize: "16px",
                }}
              >
                ✕
              </button>
            </div>
          )}

          {repairSuccess && (
            <div
              style={{
                background: "#064e3b",
                color: "#6ee7b7",
                padding: "10px 16px",
                borderRadius: "8px",
                marginBottom: "20px",
                border: "1px solid #10b981",
                fontSize: "14px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <span>{repairSuccess}</span>
                {repairOutcome && (
                  <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "#a7f3d0" }}>
                    {repairOutcome}
                  </p>
                )}
              </div>
              <button
                onClick={() => setRepairSuccess(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#6ee7b7",
                  cursor: "pointer",
                  fontWeight: "bold",
                  fontSize: "16px",
                }}
              >
                ✕
              </button>
            </div>
          )}

          {(repairError || repairDiagnostics.length > 0) && (
            <div
              style={{
                background: "#450a0a",
                color: "#fca5a5",
                padding: "12px 16px",
                borderRadius: "8px",
                marginBottom: "20px",
                border: "1px solid #ef4444",
                fontSize: "14px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div>
                  <span style={{ fontWeight: 600 }}>
                    ⚠️ {repairError || "Syntax diagnostics detected in workspace"}
                  </span>
                  {repairOutcome && repairOutcome !== repairError && (
                    <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "#fca5a5" }}>
                      {repairOutcome}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => {
                    setRepairError(null);
                    setRepairDiagnostics([]);
                    setRepairOutcome(null);
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#fca5a5",
                    cursor: "pointer",
                    fontWeight: "bold",
                    fontSize: "16px",
                  }}
                >
                  ✕
                </button>
              </div>

              {repairDiagnostics.length > 0 && (
                <div style={{ marginTop: "10px" }}>
                  <p style={{ margin: "0 0 6px 0", fontSize: "12px", color: "#fecaca", fontWeight: 600 }}>
                    Remaining diagnostics ({repairDiagnostics.length}):
                  </p>
                  <div
                    style={{
                      maxHeight: "150px",
                      overflowY: "auto",
                      background: "#1c1917",
                      borderRadius: "6px",
                      padding: "8px",
                      fontSize: "12px",
                      fontFamily: "monospace",
                    }}
                  >
                    {repairDiagnostics.map((diag, idx) => (
                      <div
                        key={idx}
                        style={{
                          marginBottom: idx < repairDiagnostics.length - 1 ? "6px" : 0,
                          borderBottom: idx < repairDiagnostics.length - 1 ? "1px solid #292524" : "none",
                          paddingBottom: idx < repairDiagnostics.length - 1 ? "4px" : 0,
                        }}
                      >
                        <span style={{ color: "#38bdf8" }}>{diag.path}</span>
                        {diag.line ? `:${diag.line}:${diag.character || 1}` : ""}:{" "}
                        <span style={{ color: "#f87171" }}>{diag.message}</span>
                        {diag.codeSnippet && (
                          <div style={{ color: "#a8a29e", marginTop: "2px", whiteSpace: "pre" }}>
                            {diag.codeSnippet}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "20px",
            }}
          >
            <div>
              <h1>AI App Builder</h1>

              <p
                style={{
                  color: "#9ca3af",
                  marginTop: "5px",
                }}
              >
                {prompt}
              </p>

              {loading && (
                <div
                  style={{
                    marginTop: "8px",
                    color: "#93c5fd",
                    fontSize: "13px",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <span>⏳</span>
                  <span>{getGenerationProgressMessage()}</span>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
              <button
                onClick={regenerateApp}
                disabled={isBusy}
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "none",
                  background: isBusy ? "#4b5563" : "#2563eb",
                  color: "white",
                  cursor: isBusy ? "not-allowed" : "pointer",
                }}
              >
                {loading ? `Regenerating... (${generationElapsed}s)` : "🔄 Regenerate"}
              </button>

              <button
                onClick={improveApp}
                disabled={isBusy}
                aria-label="AI Improve"
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "none",
                  background: isBusy ? "#4b5563" : "#7c3aed",
                  color: "white",
                  cursor: isBusy ? "not-allowed" : "pointer",
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                {improveLoading ? "✨ Improving..." : "✨ AI Improve"}
              </button>

              <button
                onClick={repairApp}
                disabled={isBusy}
                aria-label="Repair errors"
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "none",
                  background: isBusy ? "#4b5563" : "#0d9488",
                  color: "white",
                  cursor: isBusy ? "not-allowed" : "pointer",
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                {repairLoading ? "🛠️ Repairing..." : "🛠️ Repair errors"}
              </button>

              <button
                onClick={undo}
                disabled={pastSnapshots.length === 0 || isBusy}
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "1px solid #374151",
                  background: pastSnapshots.length === 0 || isBusy ? "#374151" : "#1f2937",
                  color: pastSnapshots.length === 0 || isBusy ? "#9ca3af" : "white",
                  cursor: pastSnapshots.length === 0 || isBusy ? "not-allowed" : "pointer",
                }}
              >
                ↩ Undo
              </button>

              <button
                onClick={redo}
                disabled={futureSnapshots.length === 0 || isBusy}
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "1px solid #374151",
                  background: futureSnapshots.length === 0 || isBusy ? "#374151" : "#1f2937",
                  color: futureSnapshots.length === 0 || isBusy ? "#9ca3af" : "white",
                  cursor: futureSnapshots.length === 0 || isBusy ? "not-allowed" : "pointer",
                }}
              >
                ↪ Redo
              </button>

              <button
                onClick={saveProject}
                disabled={isBusy}
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "none",
                  background: isBusy ? "#4b5563" : "#16a34a",
                  color: "white",
                  cursor: isBusy ? "not-allowed" : "pointer",
                }}
              >
                💾 Save Project
              </button>

              <button
                onClick={clearSavedProject}
                disabled={isBusy}
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "1px solid #374151",
                  background: "#1f2937",
                  color: isBusy ? "#6b7280" : "#f87171",
                  cursor: isBusy ? "not-allowed" : "pointer",
                }}
              >
                🗑️ Clear Saved Project
              </button>

              <button
                onClick={() => setShowWorkspace(false)}
                disabled={isBusy}
                style={{
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "1px solid #374151",
                  background: "#1f2937",
                  color: isBusy ? "#6b7280" : "white",
                  cursor: isBusy ? "not-allowed" : "pointer",
                }}
              >
                ← New App
              </button>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "180px 1fr 1fr",
              gap: "15px",
              minHeight: "650px",
            }}
          >
            {/* FILES PANEL */}

            <div
              style={{
                background: "#1f2937",
                borderRadius: "12px",
                padding: "15px",
              }}
            >
              <h3>📁 Files</h3>

              <div style={{ marginTop: "20px" }}>
                {(files[appType] || []).map((file) => (
                  <button
                    key={file.name}
                    onClick={() => setSelectedFile(file.name)}
                    disabled={isBusy}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "10px",
                      marginBottom: "5px",
                      borderRadius: "6px",
                      border: "none",
                      background:
                        selectedFile === file.name
                          ? "#374151"
                          : "transparent",
                      color: "white",
                      cursor: isBusy ? "not-allowed" : "pointer",
                      opacity: isBusy ? 0.7 : 1,
                    }}
                  >
                    📄 {file.name}
                  </button>
                ))}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "15px",
              }}
            >
              {/* Edit Panel */}
              <div
                style={{
                  background: "#1f2937",
                  borderRadius: "12px",
                  padding: "15px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "10px",
                    flexWrap: "wrap",
                    gap: "8px",
                  }}
                >
                  <h3>✨ AI Edit</h3>
                  <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                    <select
                      aria-label="Provider"
                      value={selectedProvider}
                      disabled={isBusy}
                      onChange={(e) => handleProviderChange(e.target.value as ModelProviderType)}
                      style={{
                        padding: "4px 8px",
                        borderRadius: "6px",
                        border: "1px solid #374151",
                        background: "#0f172a",
                        color: "white",
                        fontSize: "12px",
                        cursor: isBusy ? "not-allowed" : "pointer",
                      }}
                    >
                      {AVAILABLE_PROVIDERS.map((p) => (
                        <option key={p.provider} value={p.provider}>
                          {p.displayName}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Model"
                      value={selectedModel}
                      disabled={isBusy}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      style={{
                        padding: "4px 8px",
                        borderRadius: "6px",
                        border: "1px solid #374151",
                        background: "#0f172a",
                        color: "white",
                        fontSize: "12px",
                        cursor: isBusy ? "not-allowed" : "pointer",
                      }}
                    >
                      {AVAILABLE_PROVIDERS.find((p) => p.provider === selectedProvider)?.models.map(
                        (m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        )
                      )}
                    </select>
                  </div>
                </div>
                <textarea
                  value={editInstruction}
                  onChange={(e) => setEditInstruction(e.target.value)}
                  disabled={isBusy}
                  placeholder="Describe the changes you want to make..."
                  style={{
                    width: "100%",
                    minHeight: "80px",
                    padding: "12px",
                    borderRadius: "8px",
                    border: "1px solid #374151",
                    background: "#0f172a",
                    color: "white",
                    fontSize: "14px",
                    resize: "vertical",
                    marginBottom: "10px",
                    opacity: isBusy ? 0.7 : 1,
                  }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <button
                    onClick={applyEdit}
                    disabled={isBusy || !editInstruction.trim()}
                    style={{
                      padding: "8px 16px",
                      borderRadius: "6px",
                      border: "none",
                      background:
                        isBusy || !editInstruction.trim()
                          ? "#4b5563"
                          : "#8b5cf6",
                      color: "white",
                      cursor:
                        isBusy || !editInstruction.trim()
                          ? "not-allowed"
                          : "pointer",
                      fontWeight: "bold",
                    }}
                  >
                    {editLoading ? "Applying..." : "Apply Change"}
                  </button>
                  {editSuccess && (
                    <span style={{ color: "#10b981", fontSize: "14px" }}>
                      ✓ Changes applied
                    </span>
                  )}
                  {editError && (
                    <span style={{ color: "#ef4444", fontSize: "14px" }}>
                      {editError}
                    </span>
                  )}
                </div>
              </div>

              <div
                style={{
                  background: "#1f2937",
                  borderRadius: "12px",
                  padding: "15px",
                  display: "flex",
                  flexDirection: "column",
                  flex: 1,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "10px",
                  }}
                >
                  <h3>💻 Generated Code</h3>

                  <div>
                    <button
                      onClick={saveFile}
                      disabled={isBusy}
                      style={{
                        padding: "8px 14px",
                        borderRadius: "6px",
                        border: "none",
                        background: isBusy ? "#4b5563" : saved ? "#374151" : "#16a34a",
                        color: "white",
                        cursor: isBusy ? "not-allowed" : "pointer",
                      }}
                    >
                      {saved ? "Saved" : "Save"}
                    </button>
                    <button
                      onClick={downloadApp}
                      disabled={isBusy}
                      style={{
                        marginLeft: "10px",
                        padding: "8px 14px",
                        borderRadius: "6px",
                        border: "none",
                        background: isBusy ? "#4b5563" : "#2563eb",
                        color: "white",
                        cursor: isBusy ? "not-allowed" : "pointer",
                      }}
                    >
                      Download App
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
                  style={{
                    flex: 1,
                    width: "100%",
                    minHeight: "560px",
                    background: "#0f172a",
                    color: "#e5e7eb",
                    border: "1px solid #374151",
                    borderRadius: "8px",
                    padding: "15px",
                    fontFamily: "monospace",
                    fontSize: "13px",
                    lineHeight: "1.5",
                    resize: "none",
                  }}
                />
              </div>

              {/* PREVIEW PANEL */}

              <div
                style={{
                  background: "#1f2937",
                  borderRadius: "12px",
                  padding: "15px",
                }}
              >
                <h3 style={{ marginBottom: "15px" }}>👀 Preview</h3>

                {renderPreview()}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
