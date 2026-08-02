import { useMemo, useRef, useState } from "react";
import { FileArchive, FolderOpen, Github, UploadCloud } from "lucide-react";
import type { PaperProject, TargetVenue, UploadManifestEntry } from "@fastwrite/shared";
import { isIgnoredWorkspacePath, WRITING_PROFILES } from "@fastwrite/shared";
import { api, ApiClientError } from "../../api/client";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

interface SelectedEntry extends UploadManifestEntry {
  file?: File;
}

interface DirectorySelection {
  name: string;
  entries: SelectedEntry[];
}

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (project: PaperProject) => void;
}

type Source = "local" | "github";
type Stage = "source" | "preview" | "importing" | "error";

export function ImportDialog({ open, onClose, onImported }: ImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const uploadSessionRef = useRef<string | null>(null);
  const receivedPathsRef = useRef<Set<string>>(new Set());
  const [source, setSource] = useState<Source>("local");
  const [stage, setStage] = useState<Stage>("source");
  const [selection, setSelection] = useState<DirectorySelection | null>(null);
  const [projectName, setProjectName] = useState("");
  const [mainDocument, setMainDocument] = useState("");
  const [venue, setVenue] = useState<TargetVenue>("security-top4");
  const [repository, setRepository] = useState("");
  const [reference, setReference] = useState("");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");

  const files = useMemo(() => selection?.entries.filter((entry) => entry.kind === "file") ?? [], [selection]);
  const totalBytes = useMemo(() => files.reduce((total, entry) => total + entry.size, 0), [files]);
  const mainCandidates = useMemo(() => files.map((entry) => entry.path).filter((path) => path.toLowerCase().endsWith(".tex")), [files]);

  const close = () => {
    if (stage === "importing") return;
    reset();
    onClose();
  };

  const reset = () => {
    setSource("local");
    setStage("source");
    setSelection(null);
    setProjectName("");
    setMainDocument("");
    setVenue("security-top4");
    setRepository("");
    setReference("");
    setProgress(0);
    setMessage("");
    uploadSessionRef.current = null;
    receivedPathsRef.current = new Set();
  };

  const useSelection = async (next: DirectorySelection) => {
    const filtered = { ...next, entries: next.entries.filter((entry) => !isIgnoredWorkspacePath(entry.path)) };
    const candidates = filtered.entries.filter((entry) => entry.kind === "file" && entry.path.toLowerCase().endsWith(".tex"));
    const detected = await detectMainDocument(candidates);
    setSelection(filtered);
    setProjectName(filtered.name);
    setMainDocument(detected ?? candidates[0]?.path ?? "");
    setStage("preview");
  };

  const pickDirectory = async () => {
    setMessage("");
    if (window.showDirectoryPicker) {
      try {
        const handle = await window.showDirectoryPicker({ mode: "read" });
        await useSelection({ name: handle.name, entries: await readDirectoryHandle(handle) });
        return;
      } catch (error) {
        if ((error as DOMException).name === "AbortError") return;
        setMessage(error instanceof Error ? error.message : "Could not read the selected directory");
        return;
      }
    }
    inputRef.current?.click();
  };

  const readFallbackFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    const selectedFiles = Array.from(fileList);
    const rootName = selectedFiles[0]?.webkitRelativePath.split("/")[0] || "Imported paper";
    const entries: SelectedEntry[] = selectedFiles.map((file) => ({
      path: file.webkitRelativePath.split("/").slice(1).join("/") || file.name,
      kind: "file",
      size: file.size,
      mimeType: file.type,
      file
    }));
    await useSelection({ name: rootName, entries });
  };

  const runImport = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStage("importing");
    setProgress(0);
    setMessage(source === "local" ? "Creating upload session…" : "Cloning repository…");
    try {
      if (source === "github") {
        const project = await api.github.import({
          repository,
          ...(reference.trim() ? { ref: reference.trim() } : {}),
          ...(projectName.trim() ? { name: projectName.trim() } : {}),
          ...(mainDocument.trim() ? { mainDocument: mainDocument.trim() } : {}),
          venue
        }, controller.signal);
        setProgress(100);
        onImported(project);
        reset();
        return;
      }

      if (!selection || !mainDocument) throw new Error("Select a paper directory and main document first");
      let sessionId = uploadSessionRef.current;
      if (!sessionId) {
        const session = await api.uploads.create({
          projectName: projectName.trim(),
          mainDocument,
          venue,
          sourceName: selection.name,
          entries: selection.entries.map(({ file: _file, ...entry }) => entry)
        }, controller.signal);
        sessionId = session.id;
        uploadSessionRef.current = session.id;
        receivedPathsRef.current = new Set(session.receivedPaths);
      }
      let uploadedBytes = files.filter((entry) => receivedPathsRef.current.has(entry.path)).reduce((total, entry) => total + entry.size, 0);
      for (const entry of files) {
        if (receivedPathsRef.current.has(entry.path)) continue;
        if (!entry.file) continue;
        setMessage(`Uploading ${entry.path}`);
        await api.uploads.file(sessionId, entry.path, entry.file, controller.signal);
        receivedPathsRef.current.add(entry.path);
        uploadedBytes += entry.size;
        setProgress(totalBytes === 0 ? 90 : Math.min(90, Math.round((uploadedBytes / totalBytes) * 90)));
      }
      setMessage("Creating managed workspace…");
      const project = await api.uploads.complete(sessionId, controller.signal);
      setProgress(100);
      onImported(project);
      reset();
    } catch (error) {
      if ((error as DOMException).name === "AbortError") {
        setMessage("Import cancelled");
      } else {
        setMessage(error instanceof ApiClientError || error instanceof Error ? error.message : "Import failed");
      }
      if (error instanceof ApiClientError && error.code === "upload_not_writable") {
        uploadSessionRef.current = null;
        receivedPathsRef.current = new Set();
      }
      setStage("error");
    } finally {
      abortRef.current = null;
    }
  };

  const cancelImport = async () => {
    abortRef.current?.abort();
    const sessionId = uploadSessionRef.current;
    uploadSessionRef.current = null;
    receivedPathsRef.current = new Set();
    if (sessionId) await api.uploads.cancel(sessionId).catch(() => undefined);
    setMessage("Import cancelled");
    setStage("error");
  };

  const canSubmit = source === "github"
    ? repository.trim().length > 0
    : Boolean(selection && projectName.trim() && mainDocument);

  return (
    <Dialog
      open={open}
      title="Import a paper"
      description="FastWrite creates a managed copy. Your original folder or repository is never modified."
      width="large"
      onClose={close}
      footer={
        stage === "importing" ? (
          <Button variant="secondary" onClick={() => void cancelImport()}>Cancel import</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            {(stage === "preview" || source === "github" || stage === "error") && (
              <Button variant="primary" icon={<UploadCloud />} disabled={!canSubmit} onClick={runImport}>
                Import paper
              </Button>
            )}
          </>
        )
      }
    >
      <div className="source-tabs" role="tablist" aria-label="Import source">
        <button className={source === "local" ? "is-active" : ""} role="tab" aria-selected={source === "local"} onClick={() => { setSource("local"); setStage(selection ? "preview" : "source"); setMessage(""); }}>
          <FolderOpen aria-hidden="true" /> Local directory
        </button>
        <button className={source === "github" ? "is-active" : ""} role="tab" aria-selected={source === "github"} onClick={() => { setSource("github"); setStage("source"); setMessage(""); }}>
          <Github aria-hidden="true" /> GitHub repository
        </button>
      </div>

      {stage === "importing" ? (
        <div className="import-progress" aria-live="polite">
          <div className="import-progress__icon"><UploadCloud /></div>
          <h3>Importing your paper</h3>
          <p>{message}</p>
          <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
          <span className="progress-label">{progress}%</span>
        </div>
      ) : source === "local" ? (
        <>
          {!selection ? (
            <div className="directory-picker">
              <button className="directory-dropzone" onClick={pickDirectory}>
                <span className="directory-dropzone__icon"><FolderOpen /></span>
                <strong>Choose paper directory</strong>
                <span>LaTeX sources, bibliography, figures and style files are copied into FastWrite.</span>
              </button>
              <button className="directory-picker__fallback" onClick={() => inputRef.current?.click()}>Use browser folder upload</button>
            </div>
          ) : (
            <ImportPreview
              selection={selection}
              fileCount={files.length}
              totalBytes={totalBytes}
              projectName={projectName}
              mainDocument={mainDocument}
              mainCandidates={mainCandidates}
              venue={venue}
              onName={setProjectName}
              onMain={setMainDocument}
              onVenue={setVenue}
              onChooseAgain={pickDirectory}
            />
          )}
          <input ref={inputRef} className="visually-hidden" type="file" multiple {...{ webkitdirectory: "" }} onChange={(event) => void readFallbackFiles(event.target.files)} />
        </>
      ) : (
        <div className="github-form">
          <label className="field">
            <span>Repository URL</span>
            <input value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="https://github.com/owner/paper" autoFocus />
          </label>
          <div className="form-grid">
            <label className="field">
              <span>Branch, tag or commit <small>optional</small></span>
              <input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Default branch" />
            </label>
            <label className="field">
              <span>Project name <small>optional</small></span>
              <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Repository name" />
            </label>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>Main document <small>auto-detect if empty</small></span>
              <input value={mainDocument} onChange={(event) => setMainDocument(event.target.value)} placeholder="main.tex" />
            </label>
            <VenueField value={venue} onChange={setVenue} />
          </div>
          <div className="import-note"><FileArchive /> The resolved commit is recorded with the managed project snapshot.</div>
        </div>
      )}
      {message && stage !== "importing" ? <div className="form-error" role="alert">{message}</div> : null}
    </Dialog>
  );
}

function ImportPreview(props: {
  selection: DirectorySelection;
  fileCount: number;
  totalBytes: number;
  projectName: string;
  mainDocument: string;
  mainCandidates: string[];
  venue: TargetVenue;
  onName: (value: string) => void;
  onMain: (value: string) => void;
  onVenue: (value: TargetVenue) => void;
  onChooseAgain: () => void;
}) {
  return (
    <div className="import-preview">
      <div className="import-summary">
        <div><FolderOpen /><span><strong>{props.selection.name}</strong><small>{props.fileCount} files · {formatBytes(props.totalBytes)}</small></span></div>
        <Button variant="ghost" size="small" onClick={props.onChooseAgain}>Choose again</Button>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Project name</span>
          <input value={props.projectName} onChange={(event) => props.onName(event.target.value)} />
        </label>
        <label className="field">
          <span>Main document</span>
          <select value={props.mainDocument} onChange={(event) => props.onMain(event.target.value)}>
            {props.mainCandidates.map((path) => <option key={path} value={path}>{path}</option>)}
          </select>
        </label>
      </div>
      <VenueField value={props.venue} onChange={props.onVenue} />
      <div className="file-preview" aria-label="Files to import">
        {props.selection.entries.slice(0, 100).map((entry) => (
          <div key={`${entry.kind}:${entry.path}`} className="file-preview__row">
            <span>{entry.kind === "directory" ? "Folder" : "File"}</span>
            <code>{entry.path}</code>
            <small>{entry.kind === "file" ? formatBytes(entry.size) : ""}</small>
          </div>
        ))}
        {props.selection.entries.length > 100 ? <div className="file-preview__more">+ {props.selection.entries.length - 100} more entries</div> : null}
      </div>
    </div>
  );
}

function VenueField({ value, onChange }: { value: TargetVenue; onChange: (value: TargetVenue) => void }) {
  return (
    <label className="field">
      <span>Writing profile</span>
      <select value={value} onChange={(event) => onChange(event.target.value as TargetVenue)}>
        {WRITING_PROFILES.map((profile) => <option key={profile.value} value={profile.value}>{profile.label}</option>)}
      </select>
      <small>The selected Skill guides structure, language, revision, and review from start to finish.</small>
    </label>
  );
}

async function readDirectoryHandle(root: FileSystemDirectoryHandle): Promise<SelectedEntry[]> {
  const entries: SelectedEntry[] = [];
  const visit = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    let hasChildren = false;
    for await (const handle of directory.values()) {
      hasChildren = true;
      const path = prefix ? `${prefix}/${handle.name}` : handle.name;
      if (isIgnoredWorkspacePath(path)) continue;
      if (handle.kind === "directory") await visit(handle, path);
      else {
        const file = await handle.getFile();
        entries.push({ path, kind: "file", size: file.size, mimeType: file.type, file });
      }
    }
    if (prefix && !hasChildren) entries.push({ path: prefix, kind: "directory", size: 0 });
  };
  await visit(root, "");
  return entries;
}

async function detectMainDocument(candidates: SelectedEntry[]): Promise<string | null> {
  const ordered = [...candidates].sort((a, b) => {
    const preferred = ["main.tex", "paper.tex", "document.tex"];
    return preferred.indexOf(a.path.split("/").at(-1)?.toLowerCase() ?? "") - preferred.indexOf(b.path.split("/").at(-1)?.toLowerCase() ?? "");
  });
  for (const candidate of ordered) {
    if (!candidate.file || candidate.file.size > 2 * 1024 * 1024) continue;
    const content = await candidate.file.text();
    if (/\\documentclass(?:\[[^\]]*\])?\s*\{/.test(content)) return candidate.path;
  }
  return ordered[0]?.path ?? null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
