import { createHash, randomBytes } from "node:crypto";
import { normalizeWorkspacePath } from "@fastwrite/shared";
import type { Principal } from "../auth/auth-service";
import type { AuthorizationService } from "../auth/authorization-service";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { ResearchService } from "./research-service";
import { ApiError } from "../http";

export interface FastReadConnection { userId: string; tokenHash: string; createdAt: string; }
export interface FastReadFeedback { id: string; projectId: string; paperId: string; title: string; content: string; updatedAt: string; }
export interface FastReadBundleInput { bundle_id: string; manifest_path: string; files: Array<{ path: string; content: string }>; }
const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

export class FastReadIntegration {
  constructor(private readonly database: JsonDatabase, private readonly authorization: AuthorizationService, private readonly workspaces: WorkspaceService, private readonly research: ResearchService) {}

  status(principal: Principal) { return { connected: Boolean(this.database.snapshot().fastReadConnections?.some(item => item.userId === principal.user.id)) }; }

  async issue(principal: Principal) {
    const token = `fw_read_${randomBytes(32).toString("base64url")}`;
    await this.database.mutate(state => {
      state.fastReadConnections = (state.fastReadConnections ?? []).filter(item => item.userId !== principal.user.id);
      state.fastReadConnections.push({ userId: principal.user.id, tokenHash: tokenHash(token), createdAt: new Date().toISOString() });
    });
    return { token };
  }

  async revoke(principal: Principal) {
    await this.database.mutate(state => { state.fastReadConnections = (state.fastReadConnections ?? []).filter(item => item.userId !== principal.user.id); });
    return { connected: false };
  }

  authenticate(request: Request): Principal {
    const raw = /^Bearer (fw_read_[A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const state = this.database.snapshot();
    const record = raw && state.fastReadConnections?.find(item => item.tokenHash === tokenHash(raw));
    const user = record && state.users.find(item => item.id === record.userId && item.status === "active");
    if (!record || !user) throw new ApiError(401, "fastread_connection_invalid", "FastRead 连接码已失效，请重新连接");
    return { user, sessionId: `fastread:${user.id}` };
  }

  projects(principal: Principal) {
    return { items: this.database.snapshot().projects.filter(project => {
      try { this.authorization.requireProject(principal, project.id, "project:write"); this.authorization.requireProjectPath(principal, project.id, "references/fastread", "project:write"); return true; }
      catch (error) { if (error instanceof ApiError && error.status === 403) return false; throw error; }
    }).map(({ id, name }) => ({ id, name })) };
  }

  async receiveBundle(projectId: string, principal: Principal, input: FastReadBundleInput) {
    this.authorization.requireProject(principal, projectId, "project:write");
    if (!input || !/^[0-9a-f]{24}$/.test(input.bundle_id ?? "") || !Array.isArray(input.files) || input.files.length < 4 || input.files.length > 64) throw new ApiError(400, "fastread_bundle_invalid", "资料包格式无效");
    const directory = `references/fastread/${input.bundle_id}/`;
    if (input.manifest_path !== `${directory}manifest.json`) throw new ApiError(400, "fastread_manifest_invalid", "资料包清单路径无效");
    const paths = new Set<string>(); let bytes = 0;
    for (const file of input.files) {
      if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw new ApiError(400, "fastread_file_invalid", "资料包文件格式无效");
      let normalized: string;
      try { normalized = normalizeWorkspacePath(file.path); }
      catch { throw new ApiError(400, "fastread_file_path_invalid", "资料包文件路径无效"); }
      if (normalized !== file.path || !normalized.startsWith(directory) || paths.has(normalized)) throw new ApiError(400, "fastread_file_path_invalid", "资料包文件必须位于独立的 FastRead 目录");
      paths.add(normalized); bytes += Buffer.byteLength(file.content, "utf8");
      if (bytes > 8 * 1024 * 1024) throw new ApiError(413, "fastread_bundle_too_large", "资料包不能超过 8 MB");
      this.authorization.requireProjectPath(principal, projectId, normalized, "project:write");
    }
    if (!paths.has(input.manifest_path)) throw new ApiError(400, "fastread_manifest_missing", "资料包缺少清单");
    const pending: FastReadBundleInput["files"] = [];
    for (const file of input.files) {
      if (await this.workspaces.fileExists(projectId, file.path)) {
        if ((await this.workspaces.readTextFile(projectId, file.path)).content !== file.content) throw new ApiError(409, "fastread_bundle_conflict", "资料包已存在且内容不同，请从 FastRead 创建新版本");
      } else pending.push(file);
    }
    // Publish the manifest after its referenced files are in place.
    pending.sort((a, b) => Number(a.path === input.manifest_path) - Number(b.path === input.manifest_path));
    for (const file of pending) {
      this.authorization.requireProjectPath(principal, projectId, file.path, "project:write");
      try { await this.workspaces.createFile(projectId, file.path, file.content); }
      catch (error) {
        if (!(error instanceof ApiError && error.code === "file_exists") || (await this.workspaces.readTextFile(projectId, file.path)).content !== file.content) throw error;
      }
    }
    const receipts = await this.research.importFastReadBundles(projectId, input.manifest_path);
    if (receipts.some(receipt => receipt.status !== "imported")) throw new ApiError(409, "fastread_import_failed", receipts.find(receipt => receipt.status !== "imported")?.error ?? "资料包导入未完成");
    return { ok: true, bundle_id: input.bundle_id, receipts };
  }

  async linkedPapers(projectId: string, principal: Principal) {
    this.authorization.requireProject(principal, projectId, "project:read");
    const papers = new Map<string, { id: string; title: string }>();
    for (const bundle of this.database.snapshot().fastReadBundles.filter(item => item.projectId === projectId && item.status === "imported")) {
      const path = bundle.manifestPath.replace(/manifest\.json$/, "citations.json");
      try { this.authorization.requireProjectPath(principal, projectId, path, "project:read"); }
      catch (error) { if (error instanceof ApiError && error.status === 403) continue; throw error; }
      const payload = JSON.parse((await this.workspaces.readTextFile(projectId, path)).content) as { papers: Array<{ id: string; title: string }> };
      for (const paper of payload.papers) papers.set(paper.id, { id: paper.id, title: paper.title });
    }
    return [...papers.values()];
  }

  async feedback(projectId: string, principal: Principal) {
    const papers = await this.linkedPapers(projectId, principal), ids = new Set(papers.map(paper => paper.id));
    const state = this.database.snapshot();
    const items = (state.fastReadFeedback ?? []).filter(note => note.projectId === projectId && ids.has(note.paperId)).map(note => ({ id: note.id, paper_id: note.paperId, title: note.title, content: note.content }));
    for (const evidence of state.sourceEvidence.filter(item => item.projectId === projectId && item.sourceTaskId && ids.has(item.sourceTaskId))) {
      if (evidence.fastReadBundleId) {
        try { this.authorization.requireProjectPath(principal, projectId, `references/fastread/${evidence.fastReadBundleId}/citations.json`, "project:read"); }
        catch (error) { if (error instanceof ApiError && error.status === 403) continue; throw error; }
      }
      const status = ({ approved: "已批准", candidate: "待审阅", rejected: "已拒绝", stale: "需重新核对" })[evidence.status];
      const stance = evidence.stance ? ({ supports: "支持", contradicts: "反驳", mentions: "提及", unknown: "待判断" })[evidence.stance] : "待判断";
      items.push({ id: evidence.id, paper_id: evidence.sourceTaskId!, title: `写作证据 · 第 ${evidence.locator} 页`, content: `审阅状态：${status}\n引用立场：${stance}\n\n> ${evidence.content}${evidence.sourceNote ? `\n\n${evidence.sourceNote}` : ""}` });
    }
    return { items, papers };
  }

  async saveFeedback(projectId: string, principal: Principal, input: { paper_id: string; title?: string; content: string }) {
    this.authorization.requireProject(principal, projectId, "project:write");
    this.authorization.requireProjectPath(principal, projectId, "references/fastread", "project:write");
    const paper = (await this.linkedPapers(projectId, principal)).find(item => item.id === input.paper_id);
    if (!paper) throw new ApiError(404, "fastread_paper_not_found", "项目尚未导入这篇 FastRead 论文");
    if (typeof input.content !== "string" || !input.content.trim() || input.content.length > 30000) throw new ApiError(400, "fastread_note_invalid", "笔记需要 1–30000 字");
    const title = (input.title?.trim() || paper.title).slice(0, 120);
    return this.database.mutate(state => {
      state.fastReadFeedback ??= [];
      const old = state.fastReadFeedback.find(item => item.projectId === projectId && item.paperId === input.paper_id);
      const note: FastReadFeedback = { id: old?.id ?? crypto.randomUUID(), projectId, paperId: input.paper_id, title, content: input.content.trim(), updatedAt: new Date().toISOString() };
      if (old) Object.assign(old, note); else state.fastReadFeedback.push(note);
      return { id: note.id, paper_id: note.paperId, title: note.title, content: note.content };
    });
  }
}
