import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TargetVenue, UploadManifestEntry, UploadSession } from "@fastwrite/shared";
import { isIgnoredWorkspacePath, normalizeWorkspacePath } from "@fastwrite/shared";
import { config } from "../config";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import { resolveWorkspacePath } from "../workspace/path";

interface CreateUploadInput {
  projectName: string;
  mainDocument: string;
  venue: TargetVenue;
  sourceName: string;
  entries: UploadManifestEntry[];
}

export class UploadService {
  private readonly uploadsDirectory: string;

  constructor(
    dataDirectory: string,
    private readonly database: JsonDatabase,
    private readonly workspaces: WorkspaceService
  ) {
    this.uploadsDirectory = join(dataDirectory, "uploads");
  }

  async initialize(): Promise<void> {
    await mkdir(this.uploadsDirectory, { recursive: true });
  }

  async create(input: CreateUploadInput): Promise<UploadSession> {
    if (!input.projectName.trim()) throw new ApiError(400, "project_name_required", "Project name is required");
    if (input.entries.length === 0) throw new ApiError(400, "empty_upload", "The selected directory is empty");
    if (input.entries.length > config.maxEntries) throw new ApiError(413, "too_many_files", `A project can contain at most ${config.maxEntries} entries`);

    const normalizedEntries = input.entries.map((entry) => {
      const path = normalizeWorkspacePath(entry.path);
      if (entry.size < 0 || !Number.isSafeInteger(entry.size)) throw new ApiError(400, "invalid_size", `Invalid size for '${path}'`);
      if (entry.size > config.maxFileBytes) throw new ApiError(413, "file_too_large", `'${path}' exceeds the per-file size limit`);
      return { ...entry, path };
    }).filter((entry) => !isIgnoredWorkspacePath(entry.path));
    if (normalizedEntries.length === 0) throw new ApiError(400, "empty_upload", "The selected directory contains no paper source files");
    const duplicates = normalizedEntries.filter((entry, index) => normalizedEntries.findIndex((candidate) => candidate.path === entry.path) !== index);
    if (duplicates.length > 0) throw new ApiError(400, "duplicate_path", `Duplicate manifest path '${duplicates[0]?.path ?? "unknown"}'`);

    const totalBytes = normalizedEntries.reduce((total, entry) => total + (entry.kind === "file" ? entry.size : 0), 0);
    if (totalBytes > config.maxUploadBytes) throw new ApiError(413, "upload_too_large", "The selected project exceeds the upload size limit");

    const mainDocument = normalizeWorkspacePath(input.mainDocument);
    if (!normalizedEntries.some((entry) => entry.kind === "file" && entry.path === mainDocument)) {
      throw new ApiError(400, "main_document_missing", "The selected main document is not present in the upload manifest");
    }

    const createdAt = new Date();
    const session: UploadSession = {
      id: `upload_${crypto.randomUUID()}`,
      projectName: input.projectName.trim(),
      mainDocument,
      venue: input.venue,
      sourceName: input.sourceName,
      entries: normalizedEntries,
      receivedPaths: [],
      receivedBytes: 0,
      totalBytes,
      status: "pending",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + config.uploadTtlMs).toISOString()
    };
    const staging = this.stagingDirectory(session.id);
    await mkdir(staging, { recursive: true });
    for (const entry of normalizedEntries) {
      if (entry.kind === "directory") await mkdir(resolveWorkspacePath(staging, entry.path).absolutePath, { recursive: true });
    }
    await this.database.mutate((state) => state.uploadSessions.push(session));
    return session;
  }

  get(id: string): UploadSession {
    const session = this.database.snapshot().uploadSessions.find((candidate) => candidate.id === id);
    if (!session) throw new ApiError(404, "upload_not_found", "Upload session not found");
    return session;
  }

  async uploadFile(id: string, requestedPath: string, body: ArrayBuffer): Promise<UploadSession> {
    const session = this.getMutableSession(id);
    this.assertWritable(session);
    const path = normalizeWorkspacePath(requestedPath);
    const manifest = session.entries.find((entry) => entry.kind === "file" && entry.path === path);
    if (!manifest) throw new ApiError(404, "manifest_entry_not_found", "The file is not part of this upload session");
    if (body.byteLength !== manifest.size) {
      throw new ApiError(400, "size_mismatch", `Expected ${manifest.size} bytes but received ${body.byteLength}`);
    }
    if (manifest.checksum) {
      const actual = Buffer.from(await crypto.subtle.digest("SHA-256", body)).toString("hex");
      if (actual !== manifest.checksum.toLowerCase()) throw new ApiError(400, "checksum_mismatch", `Checksum mismatch for '${path}'`);
    }
    const absolutePath = resolveWorkspacePath(this.stagingDirectory(id), path).absolutePath;
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, new Uint8Array(body));
    await this.database.mutate((state) => {
      const stored = state.uploadSessions.find((candidate) => candidate.id === id)!;
      if (!stored.receivedPaths.includes(path)) {
        stored.receivedPaths.push(path);
        stored.receivedBytes += body.byteLength;
      }
      stored.status = "uploading";
    });
    return this.get(id);
  }

  async complete(id: string) {
    const session = this.getMutableSession(id);
    this.assertWritable(session);
    const missing = session.entries.filter((entry) => entry.kind === "file" && !session.receivedPaths.includes(entry.path));
    if (missing.length > 0) throw new ApiError(409, "upload_incomplete", `${missing.length} files have not been uploaded`, { paths: missing.slice(0, 20).map((entry) => entry.path) });
    for (const entry of session.entries.filter((candidate) => candidate.kind === "file")) {
      const info = await stat(resolveWorkspacePath(this.stagingDirectory(id), entry.path).absolutePath);
      if (info.size !== entry.size) throw new ApiError(409, "size_mismatch", `Stored size does not match for '${entry.path}'`);
    }
    await this.database.mutate((state) => {
      const stored = state.uploadSessions.find((candidate) => candidate.id === id)!;
      stored.status = "completing";
    });
    try {
      const project = await this.workspaces.importStagingDirectory({
        stagingDirectory: this.stagingDirectory(id),
        name: session.projectName,
        mainDocument: session.mainDocument,
        venue: session.venue,
        source: { type: "local", displayName: session.sourceName }
      });
      await this.database.mutate((state) => {
        const stored = state.uploadSessions.find((candidate) => candidate.id === id)!;
        stored.status = "completed";
        stored.projectId = project.id;
      });
      return project;
    } catch (error) {
      await this.database.mutate((state) => {
        const stored = state.uploadSessions.find((candidate) => candidate.id === id)!;
        stored.status = "failed";
        stored.error = error instanceof Error ? error.message : String(error);
      });
      throw error;
    }
  }

  async cancel(id: string): Promise<void> {
    const session = this.getMutableSession(id);
    if (session.status === "completed") throw new ApiError(409, "upload_completed", "A completed upload cannot be cancelled");
    await rm(this.stagingDirectory(id), { recursive: true, force: true });
    await this.database.mutate((state) => {
      const stored = state.uploadSessions.find((candidate) => candidate.id === id)!;
      stored.status = "cancelled";
    });
  }

  private stagingDirectory(id: string): string {
    return join(this.uploadsDirectory, id, "workspace");
  }

  private getMutableSession(id: string): UploadSession {
    const session = this.database.snapshot().uploadSessions.find((candidate) => candidate.id === id);
    if (!session) throw new ApiError(404, "upload_not_found", "Upload session not found");
    if (new Date(session.expiresAt).getTime() < Date.now()) throw new ApiError(410, "upload_expired", "Upload session expired");
    return session;
  }

  private assertWritable(session: UploadSession): void {
    if (["completed", "cancelled", "failed", "completing"].includes(session.status)) {
      throw new ApiError(409, "upload_not_writable", `Upload session is ${session.status}`);
    }
  }
}
