// Simple localStorage-backed store for saved AI App Builder projects.
//
// This is intentionally isolated from page.tsx and route.ts: it knows
// nothing about React state, Gemini, or the AppType bucket system. If a
// real backend/database is introduced later, only this file needs to
// change — callers keep using the same function signatures.

export type SavedProjectFile = {
  name: string;
  code: string;
};

export type SavedProject = {
  id: string;
  name: string;
  prompt: string;
  appType: string;
  files: SavedProjectFile[];
  dependencies: Record<string, string>;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
};

const STORAGE_KEY = "ai-app-builder:projects";

function readAll(): SavedProject[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (p): p is SavedProject =>
        Boolean(
          p &&
            typeof p === "object" &&
            typeof p.id === "string" &&
            typeof p.name === "string" &&
            Array.isArray(p.files)
        )
    );
  } catch (error) {
    console.error("Failed to read saved projects from localStorage:", error);
    return [];
  }
}

function writeAll(projects: SavedProject[]) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch (error) {
    console.error("Failed to write saved projects to localStorage:", error);
  }
}

export function listProjects(): SavedProject[] {
  return readAll().sort((a, b) => {
    const timeA = new Date(a.updatedAt || 0).getTime() || 0;
    const timeB = new Date(b.updatedAt || 0).getTime() || 0;
    return timeB - timeA;
  });
}

export function getProject(id: string): SavedProject | undefined {
  return readAll().find((project) => project.id === id);
}

export function createProject(
  data: Omit<SavedProject, "id" | "createdAt" | "updatedAt">
): SavedProject {
  const now = new Date().toISOString();

  const project: SavedProject = {
    ...data,
    id: `project_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now,
  };

  const projects = readAll();
  projects.push(project);
  writeAll(projects);

  return project;
}

export function updateProject(
  id: string,
  data: Partial<Omit<SavedProject, "id" | "createdAt">>
): SavedProject | undefined {
  const projects = readAll();
  const index = projects.findIndex((project) => project.id === id);

  if (index === -1) {
    return undefined;
  }

  const updated: SavedProject = {
    ...projects[index],
    ...data,
    updatedAt: new Date().toISOString(),
  };

  projects[index] = updated;
  writeAll(projects);

  return updated;
}

export function deleteProject(id: string): void {
  const projects = readAll().filter((project) => project.id !== id);
  writeAll(projects);
}

const ACTIVE_WORKSPACE_KEY = "ai-app-builder:active_workspace";

export type ActiveWorkspaceState = {
  prompt: string;
  appType: string;
  files: Record<string, SavedProjectFile[]>;
  dependencies: Record<string, Record<string, string>>;
  selectedFile: string;
  showWorkspace: boolean;
  currentProjectId: string | null;
  updatedAt: string;
};

export function saveActiveWorkspace(
  data: Omit<ActiveWorkspaceState, "updatedAt">
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const payload: ActiveWorkspaceState = {
      ...data,
      updatedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.error("Failed to save active workspace to localStorage:", error);
  }
}

export function loadActiveWorkspace(): ActiveWorkspaceState | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(ACTIVE_WORKSPACE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      clearActiveWorkspace();
      return null;
    }

    if (
      typeof parsed.prompt !== "string" ||
      typeof parsed.appType !== "string" ||
      typeof parsed.selectedFile !== "string" ||
      typeof parsed.showWorkspace !== "boolean" ||
      !parsed.files ||
      typeof parsed.files !== "object" ||
      !parsed.dependencies ||
      typeof parsed.dependencies !== "object"
    ) {
      console.warn("Invalid workspace structure in localStorage. Clearing.");
      clearActiveWorkspace();
      return null;
    }

    const appFiles = parsed.files[parsed.appType];
    if (!Array.isArray(appFiles)) {
      console.warn("Invalid workspace files structure in localStorage. Clearing.");
      clearActiveWorkspace();
      return null;
    }

    for (const file of appFiles) {
      if (
        !file ||
        typeof file !== "object" ||
        typeof file.name !== "string" ||
        typeof file.code !== "string"
      ) {
        console.warn("Invalid workspace file object in localStorage. Clearing.");
        clearActiveWorkspace();
        return null;
      }
    }

    return parsed as ActiveWorkspaceState;
  } catch (error) {
    console.warn("Failed to parse active workspace from localStorage:", error);
    clearActiveWorkspace();
    return null;
  }
}

export function clearActiveWorkspace(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  } catch (error) {
    console.error("Failed to clear active workspace from localStorage:", error);
  }
}

const WORKSPACE_HISTORY_KEY = "ai-app-builder:workspace_history";

export type WorkspaceSnapshot = {
  prompt: string;
  appType: string;
  files: Record<string, SavedProjectFile[]>;
  dependencies: Record<string, Record<string, string>>;
  selectedFile: string;
  showWorkspace: boolean;
  currentProjectId: string | null;
};

export type WorkspaceHistoryState = {
  pastSnapshots: WorkspaceSnapshot[];
  futureSnapshots: WorkspaceSnapshot[];
};

export function saveWorkspaceHistory(data: WorkspaceHistoryState): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const payload: WorkspaceHistoryState = {
      pastSnapshots: (data.pastSnapshots || []).slice(-10),
      futureSnapshots: data.futureSnapshots || [],
    };
    window.localStorage.setItem(WORKSPACE_HISTORY_KEY, JSON.stringify(payload));
  } catch (error) {
    console.error("Failed to save workspace history to localStorage:", error);
  }
}

export function loadWorkspaceHistory(): WorkspaceHistoryState | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(WORKSPACE_HISTORY_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.pastSnapshots) ||
      !Array.isArray(parsed.futureSnapshots)
    ) {
      console.warn("Invalid workspace history structure in localStorage. Clearing.");
      clearWorkspaceHistory();
      return null;
    }

    const isValidSnapshot = (snap: unknown): boolean => {
      if (!snap || typeof snap !== "object") return false;
      const s = snap as Record<string, unknown>;
      if (typeof s.prompt !== "string") return false;
      if (typeof s.appType !== "string") return false;
      if (typeof s.selectedFile !== "string") return false;
      if (typeof s.showWorkspace !== "boolean") return false;
      if (!s.files || typeof s.files !== "object") return false;
      if (!s.dependencies || typeof s.dependencies !== "object") return false;
      return true;
    };

    const pastSnapshots = (parsed.pastSnapshots as unknown[]).filter(isValidSnapshot) as WorkspaceSnapshot[];
    const futureSnapshots = (parsed.futureSnapshots as unknown[]).filter(isValidSnapshot) as WorkspaceSnapshot[];

    return {
      pastSnapshots: pastSnapshots.slice(-10),
      futureSnapshots,
    };
  } catch (error) {
    console.warn("Failed to parse workspace history from localStorage:", error);
    clearWorkspaceHistory();
    return null;
  }
}

export function clearWorkspaceHistory(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(WORKSPACE_HISTORY_KEY);
  } catch (error) {
    console.error("Failed to clear workspace history from localStorage:", error);
  }
}