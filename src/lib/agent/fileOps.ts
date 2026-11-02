export interface VirtualFile {
  path: string;
  code: string;
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export class WorkspacePathError extends WorkspaceError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export class WorkspaceFileNotFoundError extends WorkspaceError {
  constructor(path: string) {
    super(`File '${path}' does not exist in workspace.`);
    this.name = "WorkspaceFileNotFoundError";
  }
}

export class WorkspaceFileExistsError extends WorkspaceError {
  constructor(path: string) {
    super(
      `File '${path}' already exists in workspace. Use updateFile to modify existing files.`
    );
    this.name = "WorkspaceFileExistsError";
  }
}

export type FileChangeOperation =
  | { type: "create"; path: string; code: string }
  | { type: "update"; path: string; code: string }
  | { type: "delete"; path: string };

export interface ControlledChangesResult {
  appliedCount: number;
  created: string[];
  updated: string[];
  deleted: string[];
}

/**
 * Normalizes a virtual workspace relative path.
 *
 * Rules:
 * - Must be a non-empty string without null bytes or control characters.
 * - Rejects URL schemes (e.g. file://, http://).
 * - Rejects Windows drive letters (e.g. C:, C:\, D:/).
 * - Rejects UNC network paths (e.g. \\server\share or //server/share).
 * - Rejects root/absolute paths (starts with / or \).
 * - Standardizes backslashes to forward slashes.
 * - Rejects any traversal segments ("..").
 * - Strips redundant segments ("." or consecutive slashes).
 */
export function normalizeWorkspacePath(rawPath: string): string {
  if (typeof rawPath !== "string") {
    throw new WorkspacePathError("Invalid workspace path: path must be a string");
  }

  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new WorkspacePathError("Invalid workspace path: path cannot be empty");
  }

  if (/[\x00-\x1f]/.test(trimmed)) {
    throw new WorkspacePathError(
      `Invalid workspace path: control characters or null bytes are not allowed ('${rawPath}')`
    );
  }

  // Reject URL / URI schemes (e.g. file://, http://)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    throw new WorkspacePathError(
      `Invalid workspace path: URL schemes are not allowed ('${rawPath}')`
    );
  }

  // Reject Windows drive letters (e.g. C:, C:\, D:/)
  if (/^[a-zA-Z]:/.test(trimmed)) {
    throw new WorkspacePathError(
      `Invalid workspace path: Windows drive letters are not allowed ('${rawPath}')`
    );
  }

  // Reject UNC paths (e.g. \\server\share or //server/share)
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
    throw new WorkspacePathError(
      `Invalid workspace path: UNC paths are not allowed ('${rawPath}')`
    );
  }

  // Reject root/absolute paths starting with / or \
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    throw new WorkspacePathError(
      `Invalid workspace path: Absolute paths are not allowed ('${rawPath}')`
    );
  }

  // Standardize backslashes to forward slashes
  const converted = trimmed.replace(/\\/g, "/");

  // Split into path segments
  const rawSegments = converted.split("/");
  const normalizedSegments: string[] = [];

  for (const segment of rawSegments) {
    if (segment === "" || segment === ".") {
      // Ignore redundant slashes and current-directory references (./)
      continue;
    }

    if (segment === "..") {
      throw new WorkspacePathError(
        `Invalid workspace path: Path traversal ('..') is not allowed ('${rawPath}')`
      );
    }

    normalizedSegments.push(segment);
  }

  if (normalizedSegments.length === 0) {
    throw new WorkspacePathError(
      `Invalid workspace path: path cannot resolve to an empty path ('${rawPath}')`
    );
  }

  return normalizedSegments.join("/");
}

/**
 * Pure in-memory workspace file abstraction.
 * Never touches or mutates the real filesystem.
 */
export class VirtualWorkspace {
  private readonly files: Map<string, string> = new Map();

  constructor(initialFiles?: readonly VirtualFile[] | Record<string, string>) {
    if (initialFiles) {
      if (Array.isArray(initialFiles)) {
        for (const f of initialFiles) {
          if (
            !f ||
            typeof f !== "object" ||
            typeof f.path !== "string" ||
            typeof f.code !== "string"
          ) {
            throw new WorkspaceError(
              "Initial file item must be an object with string 'path' and 'code' properties"
            );
          }
          this.createFile(f.path, f.code);
        }
      } else if (typeof initialFiles === "object") {
        for (const [rawPath, code] of Object.entries(initialFiles)) {
          if (typeof code !== "string") {
            throw new WorkspaceError(
              `Initial file content for '${rawPath}' must be a string`
            );
          }
          this.createFile(rawPath, code);
        }
      } else {
        throw new WorkspaceError(
          "initialFiles must be an array of VirtualFile or a Record<string, string>"
        );
      }
    }
  }

  /**
   * Returns a copy of all virtual files in the workspace, sorted deterministically by path.
   */
  public listFiles(): VirtualFile[] {
    return Array.from(this.files.entries())
      .map(([path, code]) => ({ path, code }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Returns all normalized file paths present in the workspace.
   */
  public getFilePaths(): string[] {
    return Array.from(this.files.keys()).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Reads the code content of a file.
   * Throws WorkspaceFileNotFoundError if the file does not exist.
   */
  public readFile(rawPath: string): string {
    const normalized = normalizeWorkspacePath(rawPath);
    const content = this.files.get(normalized);
    if (content === undefined) {
      throw new WorkspaceFileNotFoundError(normalized);
    }
    return content;
  }

  /**
   * Creates a new file in the virtual workspace.
   * Throws WorkspaceFileExistsError if the file already exists (does not silently overwrite).
   */
  public createFile(rawPath: string, code: string): VirtualFile {
    const normalized = normalizeWorkspacePath(rawPath);
    if (typeof code !== "string") {
      throw new WorkspaceError(`File content must be a string for '${normalized}'`);
    }
    if (this.files.has(normalized)) {
      throw new WorkspaceFileExistsError(normalized);
    }
    this.files.set(normalized, code);
    return { path: normalized, code };
  }

  /**
   * Updates an existing file in the virtual workspace.
   * Throws WorkspaceFileNotFoundError if the file does not exist.
   */
  public updateFile(rawPath: string, code: string): VirtualFile {
    const normalized = normalizeWorkspacePath(rawPath);
    if (typeof code !== "string") {
      throw new WorkspaceError(`File content must be a string for '${normalized}'`);
    }
    if (!this.files.has(normalized)) {
      throw new WorkspaceFileNotFoundError(normalized);
    }
    this.files.set(normalized, code);
    return { path: normalized, code };
  }

  /**
   * Deletes a file from the virtual workspace.
   * Throws WorkspaceFileNotFoundError if the file does not exist.
   */
  public deleteFile(rawPath: string): boolean {
    const normalized = normalizeWorkspacePath(rawPath);
    if (!this.files.has(normalized)) {
      throw new WorkspaceFileNotFoundError(normalized);
    }
    this.files.delete(normalized);
    return true;
  }

  /**
   * Checks whether a file exists in the workspace.
   */
  public hasFile(rawPath: string): boolean {
    try {
      const normalized = normalizeWorkspacePath(rawPath);
      return this.files.has(normalized);
    } catch {
      return false;
    }
  }

  /**
   * Returns the count of files in the workspace.
   */
  public getFileCount(): number {
    return this.files.size;
  }

  /**
   * Returns an object mapping normalized paths to code contents.
   */
  public toRecord(): Record<string, string> {
    const record: Record<string, string> = {};
    for (const [path, code] of this.files.entries()) {
      record[path] = code;
    }
    return record;
  }

  /**
   * Applies a controlled batch of changes to the in-memory workspace.
   * Performs atomic pre-validation on a clone so failures leave the workspace unmutated.
   * Does not silently overwrite existing files.
   */
  public applyControlledChanges(
    changes: readonly FileChangeOperation[]
  ): ControlledChangesResult {
    if (!Array.isArray(changes)) {
      throw new WorkspaceError("Changes must be an array of FileChangeOperation");
    }

    // Step 1: Pre-validate all changes on a temporary clone
    const stagedClone = this.clone();
    const created: string[] = [];
    const updated: string[] = [];
    const deleted: string[] = [];

    for (const change of changes) {
      if (!change || typeof change !== "object" || typeof change.type !== "string") {
        throw new WorkspaceError("Each change operation must have a valid 'type'");
      }

      switch (change.type) {
        case "create": {
          const res = stagedClone.createFile(change.path, change.code);
          created.push(res.path);
          break;
        }
        case "update": {
          const res = stagedClone.updateFile(change.path, change.code);
          updated.push(res.path);
          break;
        }
        case "delete": {
          stagedClone.deleteFile(change.path);
          deleted.push(normalizeWorkspacePath(change.path));
          break;
        }
        default:
          throw new WorkspaceError(
            `Unsupported file change operation type: '${(change as { type: string }).type}'`
          );
      }
    }

    // Step 2: Apply atomically to this workspace
    this.clear();
    for (const file of stagedClone.listFiles()) {
      this.files.set(file.path, file.code);
    }

    return {
      appliedCount: changes.length,
      created,
      updated,
      deleted,
    };
  }

  /**
   * Creates an independent deep clone of the virtual workspace.
   */
  public clone(): VirtualWorkspace {
    return new VirtualWorkspace(this.listFiles());
  }

  /**
   * Removes all files from the virtual workspace.
   */
  public clear(): void {
    this.files.clear();
  }
}

// Functional wrappers for convenience
export function readFile(workspace: VirtualWorkspace, path: string): string {
  return workspace.readFile(path);
}

export function createFile(
  workspace: VirtualWorkspace,
  path: string,
  code: string
): VirtualFile {
  return workspace.createFile(path, code);
}

export function updateFile(
  workspace: VirtualWorkspace,
  path: string,
  code: string
): VirtualFile {
  return workspace.updateFile(path, code);
}

export function deleteFile(workspace: VirtualWorkspace, path: string): boolean {
  return workspace.deleteFile(path);
}

export function applyControlledChanges(
  workspace: VirtualWorkspace,
  changes: readonly FileChangeOperation[]
): ControlledChangesResult {
  return workspace.applyControlledChanges(changes);
}
