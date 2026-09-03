import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, relative } from "node:path";
import type {
  DirectoryTreeNode,
  FileContentResponse,
  FileTreeNode,
  ImportSource,
  OutlineItem,
  PaperFile,
  PaperProject,
  PublicationTarget,
  SaveFileRequest,
  SaveFileResponse,
  TargetVenue,
  WorkspaceTreeNode
} from "@fastwrite/shared";
import { isIgnoredWorkspacePath, isImageFile, isTextFile, normalizePublicationTarget, normalizeWorkspacePath, paperSkillForProfile, sortWorkspaceNames } from "@fastwrite/shared";
import { ApiError } from "../http";
import { logServerError } from "../safe-log";
import type { JsonDatabase } from "../storage/database";
import { buildLatexOutline, parseLatexDocumentEntries } from "./outline";
import { resolveWorkspacePath } from "./path";
import { GitHistory } from "./git-history";

function now(): string {
  return new Date().toISOString();
}

function projectId(): string {
  return `paper_${crypto.randomUUID()}`;
}

export class WorkspaceService {
  private readonly projectsDirectory: string;
  private readonly gitHistory = new GitHistory();
  private readonly historyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly dataDirectory: string, private readonly database: JsonDatabase) {
    this.projectsDirectory = join(dataDirectory, "projects");
  }

  async initialize(): Promise<void> {
    await mkdir(this.projectsDirectory, { recursive: true });
    await this.repairLegacyMainDocuments();
    for (const project of this.database.snapshot().projects) await this.snapshotHistory(project.id, "Initialize managed paper history");
  }

  listProjects(): PaperProject[] {
    return this.database.snapshot().projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getProject(id: string): PaperProject {
    const project = this.database.snapshot().projects.find((candidate) => candidate.id === id);
    if (!project) throw new ApiError(404, "project_not_found", "Project not found");
    return project;
  }

  async deleteProject(id: string): Promise<void> {
    this.getProject(id);
    const projectDirectory = join(this.projectsDirectory, id);
    await rm(projectDirectory, { recursive: true, force: true });
    await this.database.deleteProject(id);
  }

  workspaceRoot(id: string): string {
    this.getProject(id);
    return join(this.projectsDirectory, id, "workspace");
  }

  async createEmpty(name: string, mainDocument = "main.tex", venue: TargetVenue = "network-information-security", publicationTarget?: PublicationTarget): Promise<PaperProject> {
    const normalizedMain = normalizeWorkspacePath(mainDocument);
    const id = projectId();
    const root = join(this.projectsDirectory, id, "workspace");
    await mkdir(dirname(join(root, normalizedMain)), { recursive: true });
    const template = `\\documentclass{article}\n\\title{${name.replace(/[{}\\]/g, "")} }\n\\author{}\n\\begin{document}\n\\maketitle\n\n\\section{Introduction}\n\n\\end{document}\n`;
    await writeFile(join(root, normalizedMain), template, "utf8");
    return this.registerProject(id, name, normalizedMain, venue, { type: "local", displayName: "New paper" }, [normalizedMain], publicationTarget);
  }

  async importStagingDirectory(input: {
    stagingDirectory: string;
    name: string;
    mainDocument: string;
    venue: TargetVenue;
    publicationTarget?: PublicationTarget;
    source: ImportSource;
  }): Promise<PaperProject> {
    const id = projectId();
    const projectDirectory = join(this.projectsDirectory, id);
    const workspaceRoot = join(projectDirectory, "workspace");
    const normalizedMain = normalizeWorkspacePath(input.mainDocument);
    await mkdir(projectDirectory, { recursive: true });
    await rename(input.stagingDirectory, workspaceRoot).catch(async () => {
      await cp(input.stagingDirectory, workspaceRoot, { recursive: true, errorOnExist: true });
      await rm(input.stagingDirectory, { recursive: true, force: true });
    });
    const files = await this.listRelativeFiles(workspaceRoot);
    if (!files.includes(normalizedMain)) {
      await rm(projectDirectory, { recursive: true, force: true });
      throw new ApiError(400, "main_document_missing", `Main document '${normalizedMain}' was not uploaded`);
    }
    return this.registerProject(id, input.name, normalizedMain, input.venue, input.source, files, input.publicationTarget);
  }

  async copyExternalDirectory(input: {
    sourceDirectory: string;
    name: string;
    mainDocument?: string;
    venue: TargetVenue;
    publicationTarget?: PublicationTarget;
    source: ImportSource;
  }): Promise<PaperProject> {
    const temporary = join(this.dataDirectory, "imports", crypto.randomUUID());
    await mkdir(temporary, { recursive: true });
    await this.copySafeTree(input.sourceDirectory, temporary);
    const files = await this.listRelativeFiles(temporary);
    const mainDocument = input.mainDocument
      ? normalizeWorkspacePath(input.mainDocument)
      : await this.detectMainDocument(temporary, files);
    return this.importStagingDirectory({
      stagingDirectory: temporary,
      name: input.name,
      mainDocument,
      venue: input.venue,
      ...(input.publicationTarget ? { publicationTarget: input.publicationTarget } : {}),
      source: input.source
    });
  }

  async tree(id: string): Promise<WorkspaceTreeNode[]> {
    return this.readTree(this.workspaceRoot(id), "");
  }

  async treeLevel(id: string, requestedDirectory = ""): Promise<WorkspaceTreeNode[]> {
    const root = this.workspaceRoot(id);
    this.getProject(id);
    const directory = requestedDirectory ? resolveWorkspacePath(root, requestedDirectory) : { relativePath: "", absolutePath: root };
    const info = await stat(directory.absolutePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(404, "directory_not_found", "Workspace directory not found");
      throw error;
    });
    if (!info.isDirectory()) throw new ApiError(400, "not_a_directory", "The requested Workspace path is not a directory");
    return this.readTree(root, directory.relativePath, false);
  }

  async readTextFile(id: string, requestedPath: string): Promise<FileContentResponse> {
    const root = this.workspaceRoot(id);
    const { relativePath, absolutePath } = resolveWorkspacePath(root, requestedPath);
    if (!isTextFile(relativePath)) throw new ApiError(415, "binary_file", "This file cannot be opened in the source editor");
    const info = await this.safeFileStat(absolutePath);
    const versions = this.database.snapshot().fileVersions[id] ?? {};
    return {
      file: this.paperFile(relativePath, info.size, versions[relativePath]?.version ?? 1, versions[relativePath]?.updatedAt ?? info.mtime.toISOString()),
      content: await readFile(absolutePath, "utf8")
    };
  }

  async fileExists(id: string, requestedPath: string): Promise<boolean> {
    const target = resolveWorkspacePath(this.workspaceRoot(id), requestedPath);
    try {
      return (await lstat(target.absolutePath)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async readAsset(id: string, requestedPath: string): Promise<Response> {
    const root = this.workspaceRoot(id);
    const { relativePath, absolutePath } = resolveWorkspacePath(root, requestedPath);
    await this.safeFileStat(absolutePath);
    return new Response(Bun.file(absolutePath), {
      headers: {
        "content-type": Bun.file(absolutePath).type || "application/octet-stream",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(relativePath))}`
      }
    });
  }

  async saveTextFile(id: string, requestedPath: string, request: SaveFileRequest): Promise<SaveFileResponse> {
    const project = this.getProject(id);
    const root = this.workspaceRoot(id);
    const { relativePath, absolutePath } = resolveWorkspacePath(root, requestedPath);
    if (!isTextFile(relativePath)) throw new ApiError(415, "binary_file", "Binary files cannot be saved as source text");
    await this.safeFileStat(absolutePath);
    const currentVersion = this.database.snapshot().fileVersions[id]?.[relativePath]?.version ?? 1;
    if (request.baseVersion !== currentVersion) {
      throw new ApiError(409, "version_conflict", "The file changed since it was opened", { currentVersion });
    }
    const timestamp = now();
    await writeFile(absolutePath, request.content, "utf8");
    const nextFileVersion = currentVersion + 1;
    const nextProjectVersion = project.version + 1;
    await this.database.mutate((state) => {
      const fileVersions = state.fileVersions[id] ?? {};
      fileVersions[relativePath] = { version: nextFileVersion, updatedAt: timestamp };
      state.fileVersions[id] = fileVersions;
      const storedProject = state.projects.find((candidate) => candidate.id === id);
      if (storedProject) {
        storedProject.version = nextProjectVersion;
        storedProject.updatedAt = timestamp;
      }
    });
    this.scheduleHistorySnapshot(id, `Autosave ${relativePath}`);
    return {
      file: this.paperFile(relativePath, Buffer.byteLength(request.content), nextFileVersion, timestamp),
      projectVersion: nextProjectVersion
    };
  }

  async createFile(id: string, requestedPath: string, content = ""): Promise<PaperFile> {
    const root = this.workspaceRoot(id);
    const { relativePath, absolutePath } = resolveWorkspacePath(root, requestedPath);
    this.assertPaperSourcePath(relativePath);
    try {
      await lstat(absolutePath);
      throw new ApiError(409, "file_exists", "A file or folder already exists at this path");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
    const timestamp = now();
    await this.touchProject(id, relativePath, 1, timestamp);
    await this.snapshotHistory(id, `Create ${relativePath}`);
    return this.paperFile(relativePath, Buffer.byteLength(content), 1, timestamp);
  }

  async addFile(id: string, requestedPath: string, content: ArrayBuffer): Promise<PaperFile> {
    const root = this.workspaceRoot(id);
    const { relativePath, absolutePath } = resolveWorkspacePath(root, requestedPath);
    this.assertPaperSourcePath(relativePath);
    try {
      await lstat(absolutePath);
      throw new ApiError(409, "file_exists", "A file or folder already exists at this path");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, new Uint8Array(content));
    const timestamp = now();
    await this.touchProject(id, relativePath, 1, timestamp);
    await this.snapshotHistory(id, `Add ${relativePath}`);
    return this.paperFile(relativePath, content.byteLength, 1, timestamp);
  }

  async renamePath(id: string, fromPath: string, toPath: string): Promise<void> {
    const root = this.workspaceRoot(id);
    const from = resolveWorkspacePath(root, fromPath);
    const to = resolveWorkspacePath(root, toPath);
    this.assertPaperSourcePath(to.relativePath);
    await this.safeFileStat(from.absolutePath);
    try {
      await lstat(to.absolutePath);
      throw new ApiError(409, "file_exists", "A file or folder already exists at the destination path");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(to.absolutePath), { recursive: true });
    await rename(from.absolutePath, to.absolutePath);
    const timestamp = now();
    await this.database.mutate((state) => {
      const versions = state.fileVersions[id] ?? {};
      for (const key of Object.keys(versions)) {
        if (key === from.relativePath || key.startsWith(`${from.relativePath}/`)) {
          const nextKey = `${to.relativePath}${key.slice(from.relativePath.length)}`;
          versions[nextKey] = versions[key]!;
          delete versions[key];
        }
      }
      const project = state.projects.find((candidate) => candidate.id === id);
      if (project) {
        if (project.mainDocument === from.relativePath) project.mainDocument = to.relativePath;
        project.updatedAt = timestamp;
        project.version += 1;
      }
      for (const claim of state.paperClaims.filter((candidate) => candidate.projectId === id && (candidate.anchor.path === from.relativePath || candidate.anchor.path.startsWith(`${from.relativePath}/`)))) {
        claim.anchorStatus = "stale";
        claim.updatedAt = timestamp;
      }
    });
    await this.snapshotHistory(id, `Rename ${from.relativePath} to ${to.relativePath}`);
  }

  async deletePath(id: string, requestedPath: string): Promise<void> {
    const project = this.getProject(id);
    const root = this.workspaceRoot(id);
    const target = resolveWorkspacePath(root, requestedPath);
    if (target.relativePath === project.mainDocument) {
      throw new ApiError(409, "main_document", "Choose another main document before deleting this file");
    }
    await this.safeFileStat(target.absolutePath);
    const trashTarget = join(this.projectsDirectory, id, "trash", `${Date.now()}-${basename(target.relativePath)}`);
    await mkdir(dirname(trashTarget), { recursive: true });
    await rename(target.absolutePath, trashTarget);
    await this.database.mutate((state) => {
      const versions = state.fileVersions[id] ?? {};
      for (const key of Object.keys(versions)) {
        if (key === target.relativePath || key.startsWith(`${target.relativePath}/`)) delete versions[key];
      }
      const stored = state.projects.find((candidate) => candidate.id === id);
      if (stored) {
        stored.updatedAt = now();
        stored.version += 1;
      }
      for (const claim of state.paperClaims.filter((candidate) => candidate.projectId === id && (candidate.anchor.path === target.relativePath || candidate.anchor.path.startsWith(`${target.relativePath}/`)))) {
        claim.anchorStatus = "orphaned";
        claim.updatedAt = now();
      }
    });
    await this.snapshotHistory(id, `Delete ${target.relativePath}`);
  }

  async outline(id: string): Promise<OutlineItem[]> {
    const project = this.getProject(id);
    const items: OutlineItem[] = [];
    const visited = new Set<string>();
    const visit = async (path: string): Promise<void> => {
      const normalizedPath = normalizeWorkspacePath(path);
      if (visited.has(normalizedPath)) return;
      visited.add(normalizedPath);
      const source = await this.readTextFile(id, normalizedPath);
      for (const entry of parseLatexDocumentEntries(source.content, normalizedPath)) {
        if (entry.type === "heading") { items.push(entry.item); continue; }
        const requested = extname(entry.path) ? entry.path : `${entry.path}.tex`;
        const includedPath = normalizeWorkspacePath(join(dirname(normalizedPath), requested).replaceAll("\\", "/"));
        try {
          await visit(includedPath);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
        }
      }
    };
    await visit(project.mainDocument);
    return buildLatexOutline(items);
  }

  async createHistoryCheckpoint(id: string): Promise<{ createdAt: string }> {
    this.getProject(id);
    this.clearHistoryTimer(id);
    await this.snapshotHistory(id, "Manual checkpoint");
    return { createdAt: now() };
  }

  async createSyncCheckpoint(id: string): Promise<void> {
    this.getProject(id);
    this.clearHistoryTimer(id);
    await this.snapshotHistory(id, "Before GitHub sync");
  }

  async applyGithubSyncTree(id: string, sourceDirectory: string): Promise<PaperProject> {
    const project = this.getProject(id);
    const root = this.workspaceRoot(id);
    const syncedMain = resolveWorkspacePath(sourceDirectory, project.mainDocument).absolutePath;
    await this.safeFileStat(syncedMain).catch(() => {
      throw new ApiError(409, "github_sync_main_document_deleted", `GitHub sync would remove the main document '${project.mainDocument}'`);
    });

    const beforeFiles = await this.listRelativeFiles(root);
    const beforeHashes = await this.fileHashes(root, beforeFiles);
    await this.removeManagedTree(root, root);
    await this.copySafeTree(sourceDirectory, root);
    const afterFiles = await this.listRelativeFiles(root);
    const afterHashes = await this.fileHashes(root, afterFiles);
    const changedPaths = new Set([...beforeFiles, ...afterFiles].filter((path) => beforeHashes.get(path) !== afterHashes.get(path)));
    if (changedPaths.size === 0) return project;

    const timestamp = now();
    const updated = await this.database.mutate((state) => {
      const versions = state.fileVersions[id] ?? {};
      for (const path of Object.keys(versions)) if (!afterHashes.has(path)) delete versions[path];
      for (const path of afterFiles) {
        if (!versions[path]) versions[path] = { version: 1, updatedAt: timestamp };
        else if (changedPaths.has(path)) versions[path] = { version: versions[path]!.version + 1, updatedAt: timestamp };
      }
      state.fileVersions[id] = versions;
      const stored = state.projects.find((candidate) => candidate.id === id);
      if (!stored) throw new ApiError(404, "project_not_found", "Project not found");
      stored.version += 1;
      stored.updatedAt = timestamp;
      return stored;
    });
    await this.snapshotHistory(id, "Apply GitHub sync");
    return updated;
  }

  async updateGithubSyncSource(id: string, branch: string, commit: string): Promise<PaperProject> {
    return this.database.mutate((state) => {
      const project = state.projects.find((candidate) => candidate.id === id);
      if (!project) throw new ApiError(404, "project_not_found", "Project not found");
      if (project.source.type !== "github") throw new ApiError(409, "github_sync_unavailable", "This paper is not linked to a GitHub repository");
      project.source.ref = branch;
      project.source.commit = commit;
      project.updatedAt = now();
      return project;
    });
  }

  async updateProject(id: string, updates: { name?: string; mainDocument?: string; venue?: TargetVenue; publicationTarget?: PublicationTarget | null }): Promise<PaperProject> {
    if (updates.mainDocument) {
      const normalizedMain = normalizeWorkspacePath(updates.mainDocument);
      if (!normalizedMain.toLowerCase().endsWith(".tex") || isIgnoredWorkspacePath(normalizedMain)) {
        throw new ApiError(400, "invalid_main_document", "The main document must be a .tex file");
      }
      await this.safeFileStat(resolveWorkspacePath(this.workspaceRoot(id), normalizedMain).absolutePath);
    }
    return this.database.mutate((state) => {
      const project = state.projects.find((candidate) => candidate.id === id);
      if (!project) throw new ApiError(404, "project_not_found", "Project not found");
      if (updates.name?.trim()) project.name = updates.name.trim();
      if (updates.mainDocument) project.mainDocument = normalizeWorkspacePath(updates.mainDocument);
      if (updates.venue) project.skill = paperSkillForProfile(updates.venue);
      if (updates.publicationTarget === null) delete project.publicationTarget;
      else if (updates.publicationTarget) {
        const normalized = normalizePublicationTarget(updates.publicationTarget, project.skill.id);
        if (normalized) project.publicationTarget = normalized;
        else delete project.publicationTarget;
      } else if (updates.venue && project.publicationTarget && !normalizePublicationTarget(project.publicationTarget, project.skill.id)) delete project.publicationTarget;
      project.updatedAt = now();
      project.version += 1;
      return project;
    });
  }

  exportProject(id: string): Response {
    const project = this.getProject(id);
    const root = this.workspaceRoot(id);
    const archiveName = `${project.name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "paper"}.tar.gz`;
    const child = Bun.spawn(["tar", "-czf", "-", "-C", root,
      "--exclude=./.git", "--exclude=./.writeagent", "--exclude=./.fastwrite",
      "--exclude=./node_modules", "--exclude=./output", "--exclude=./build",
      "--exclude=./dist", "--exclude=./backup", "--exclude=./backups", "."], {
      stdout: "pipe",
      stderr: "pipe"
    });
    void new Response(child.stderr).text().then((message) => {
      if (message.trim()) logServerError("workspace export failed", Object.assign(new Error("Archive process failed"), { code: "ARCHIVE_FAILED" }));
    });
    return new Response(child.stdout, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${archiveName}"`,
        "cache-control": "no-store"
      }
    });
  }

  private async registerProject(
    id: string,
    name: string,
    mainDocument: string,
    venue: TargetVenue,
    source: ImportSource,
    files: string[],
    publicationTarget?: PublicationTarget
  ): Promise<PaperProject> {
    const timestamp = now();
    const skill = paperSkillForProfile(venue);
    const target = normalizePublicationTarget(publicationTarget, skill.id);
    const project: PaperProject = {
      id,
      name: name.trim() || basename(mainDocument, extname(mainDocument)),
      mainDocument,
      skill,
      ...(target ? { publicationTarget: target } : {}),
      source,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1
    };
    await this.database.mutate((state) => {
      state.projects.push(project);
      state.fileVersions[id] = Object.fromEntries(files.map((path) => [path, { version: 1, updatedAt: timestamp }]));
    });
    await this.snapshotHistory(id, "Import paper snapshot");
    return project;
  }

  private async touchProject(id: string, path: string, version: number, updatedAt: string): Promise<void> {
    await this.database.mutate((state) => {
      const versions = state.fileVersions[id] ?? {};
      versions[path] = { version, updatedAt };
      state.fileVersions[id] = versions;
      const project = state.projects.find((candidate) => candidate.id === id);
      if (project) {
        project.updatedAt = updatedAt;
        project.version += 1;
      }
      for (const claim of state.paperClaims.filter((candidate) => candidate.projectId === id && candidate.anchor.path === path && candidate.anchor.fileVersion < version)) {
        claim.anchorStatus = "stale";
        claim.updatedAt = updatedAt;
      }
    });
  }

  private paperFile(path: string, size: number, version: number, updatedAt: string): PaperFile {
    return {
      path,
      name: basename(path),
      kind: isImageFile(path) ? "image" : isTextFile(path) ? "text" : "binary",
      size,
      version,
      updatedAt
    };
  }

  private async safeFileStat(path: string) {
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new ApiError(400, "not_a_file", "The requested path is not a file");
      return info;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(404, "file_not_found", "File not found");
      throw error;
    }
  }

  private assertPaperSourcePath(path: string): void {
    if (isIgnoredWorkspacePath(path)) throw new ApiError(400, "internal_workspace_path", "Internal metadata and generated-output directories cannot be added to the paper workspace");
  }

  private async readTree(root: string, parent: string, recursive = true): Promise<WorkspaceTreeNode[]> {
    const directory = join(root, parent);
    const entries = await readdir(directory, { withFileTypes: true });
    const versions = this.database.snapshot().fileVersions;
    const project = this.database.snapshot().projects.find((candidate) => this.workspaceRoot(candidate.id) === root);
    const projectVersions = project ? versions[project.id] ?? {} : {};
    const nodes: WorkspaceTreeNode[] = [];
    for (const entry of entries.sort((a, b) => sortWorkspaceNames(a.name, b.name))) {
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      if (isIgnoredWorkspacePath(path) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const node: DirectoryTreeNode = { type: "directory", path, name: entry.name, children: recursive ? await this.readTree(root, path, true) : [], loaded: recursive };
        nodes.push(node);
      } else if (entry.isFile()) {
        const info = await entryInfo(join(root, path));
        const storedVersion = projectVersions[path];
        const node: FileTreeNode = {
          type: "file",
          ...this.paperFile(path, info.size, storedVersion?.version ?? 1, storedVersion?.updatedAt ?? info.mtime.toISOString())
        };
        nodes.push(node);
      }
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return sortWorkspaceNames(a.name, b.name);
    });
  }

  private async listRelativeFiles(root: string): Promise<string[]> {
    const result: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        const path = relative(root, absolute).replaceAll("\\", "/");
        if (isIgnoredWorkspacePath(path) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) result.push(path);
      }
    };
    await visit(root);
    return result.sort(sortWorkspaceNames);
  }

  private async detectMainDocument(root: string, files: string[]): Promise<string> {
    const texFiles = files.filter((path) => path.toLowerCase().endsWith(".tex"));
    for (const path of texFiles) {
      const content = await readFile(join(root, path), "utf8").catch(() => "");
      if (/\\documentclass(?:\[[^\]]*\])?\s*\{/.test(content)) return path;
    }
    const conventional = texFiles.find((path) => ["main.tex", "paper.tex", "document.tex"].includes(basename(path).toLowerCase()));
    if (conventional) return conventional;
    if (texFiles[0]) return texFiles[0];
    throw new ApiError(400, "main_document_missing", "No LaTeX main document was found");
  }

  private async copySafeTree(source: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = join(source, entry.name);
      const to = join(destination, entry.name);
      if (isIgnoredWorkspacePath(relative(destination, to).replaceAll("\\", "/")) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await this.copySafeTree(from, to);
      else if (entry.isFile()) await cp(from, to, { force: false, errorOnExist: true });
    }
  }

  private async removeManagedTree(root: string, directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replaceAll("\\", "/");
      if (isIgnoredWorkspacePath(path)) continue;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await this.removeManagedTree(root, absolute);
        if ((await readdir(absolute)).length === 0) await rm(absolute, { recursive: true, force: true });
      } else {
        await rm(absolute, { recursive: true, force: true });
      }
    }
  }

  private async fileHashes(root: string, paths: string[]): Promise<Map<string, string>> {
    return new Map(await Promise.all(paths.map(async (path) => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")] as const)));
  }

  private async repairLegacyMainDocuments(): Promise<void> {
    for (const project of this.database.snapshot().projects) {
      const root = join(this.projectsDirectory, project.id, "workspace");
      const files: string[] = await this.listRelativeFiles(root).catch((): string[] => []);
      if (files.includes(project.mainDocument) && !isIgnoredWorkspacePath(project.mainDocument)) continue;
      const mainDocument = await this.detectMainDocument(root, files).catch(() => null);
      if (!mainDocument) continue;
      await this.database.mutate((state) => {
        const stored = state.projects.find((candidate) => candidate.id === project.id);
        if (stored) {
          stored.mainDocument = mainDocument;
          stored.updatedAt = now();
        }
      });
    }
  }

  private async snapshotHistory(id: string, message: string): Promise<string | undefined> {
    const projectDirectory = join(this.projectsDirectory, id);
    return this.gitHistory.snapshot(projectDirectory, join(projectDirectory, "workspace"), message).catch((error) => {
      logServerError("managed Git history update failed", error);
      return undefined;
    });
  }

  async commitHistory(id: string, message: string): Promise<string | undefined> {
    this.getProject(id);
    this.clearHistoryTimer(id);
    return this.snapshotHistory(id, message);
  }

  async history(id: string, limit?: number): Promise<Array<{ oid: string; message: string; createdAt: string }>> {
    const project = this.getProject(id);
    return this.gitHistory.list(join(this.projectsDirectory, project.id), limit);
  }

  async historySummary(id: string, oid: string): Promise<{ oid: string; message: string; createdAt: string; paths: string[] }> {
    const project = this.getProject(id);
    try {
      return await this.gitHistory.summary(join(this.projectsDirectory, project.id), oid);
    } catch {
      const history = await this.gitHistory.list(join(this.projectsDirectory, project.id), 200);
      const entry = history.find((item) => item.oid === oid || item.oid.startsWith(oid));
      if (entry) return { ...entry, paths: [] };
      if (!/^[0-9a-f]{7,64}$/i.test(oid)) throw new ApiError(404, "history_checkpoint_not_found", "History checkpoint not found");
      return { oid, message: "", createdAt: "", paths: [] };
    }
  }

  async historyFile(id: string, oid: string, path: string): Promise<string> {
    const project = this.getProject(id);
    return this.gitHistory.fileAt(join(this.projectsDirectory, project.id), oid, path);
  }

  async restoreHistoryFiles(id: string, oid: string, paths: string[]): Promise<{ oid?: string; restored: string[] }> {
    const targets = [...new Set(paths)];
    const files = await Promise.all(targets.map(async (path) => ({ path, content: await this.historyFile(id, oid, path), opened: await this.readTextFile(id, path) })));
    for (const file of files) await this.saveTextFile(id, file.path, { content: file.content, baseVersion: file.opened.file.version });
    const restored = files.map((file) => file.path);
    const checkpoint = await this.commitHistory(id, `Restore history checkpoint ${oid}`);
    return { ...(checkpoint ? { oid: checkpoint } : {}), restored };
  }

  private scheduleHistorySnapshot(id: string, message: string): void {
    const current = this.historyTimers.get(id);
    if (current) clearTimeout(current);
    const timer = setTimeout(() => {
      this.historyTimers.delete(id);
      void this.snapshotHistory(id, message);
    }, 2 * 60 * 1000);
    timer.unref?.();
    this.historyTimers.set(id, timer);
  }

  private clearHistoryTimer(id: string): void {
    const timer = this.historyTimers.get(id);
    if (timer) clearTimeout(timer);
    this.historyTimers.delete(id);
  }
}

async function entryInfo(path: string) {
  return stat(path);
}
