import { useMemo, useRef, useState } from "react";
import type { PaperProject, PublicationTarget, TargetVenue, UploadManifestEntry } from "@fastwrite/shared";
import { isIgnoredWorkspacePath, WRITING_PROFILES } from "@fastwrite/shared";
import { api, ApiClientError } from "../../api/client";
import { Button, Dialog, Field, FileField, Icon, icons, Select, TabBar, TextField } from "../ui";
import { PublicationTargetFields } from "../ui/PublicationTargetFields";

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
  const [venue, setVenue] = useState<TargetVenue>("network-information-security");
  const [publicationTarget, setPublicationTarget] = useState<PublicationTarget | undefined>();
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
    setVenue("network-information-security");
    setPublicationTarget(undefined);
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

  const readFallbackFiles = async (selectedFiles: File[]) => {
    if (!selectedFiles.length) return;
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
          venue,
          ...(publicationTarget ? { publicationTarget } : {})
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
          ...(publicationTarget ? { publicationTarget } : {}),
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
      setMessage("Creating paper workspace…");
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
      description="Bring a local LaTeX directory or GitHub repository into your FastWrite workspace."
      width="large"
      onClose={close}
      footer={
        stage === "importing" ? (
          <Button variant="secondary" onClick={() => void cancelImport()}>Cancel import</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            {(stage === "preview" || source === "github" || stage === "error") && (
              <Button variant="primary" icon={<Icon name={icons.cloudUpload} />} disabled={!canSubmit} onClick={runImport}>
                Import paper
              </Button>
            )}
          </>
        )
      }
    >
      <TabBar
        className="source-tabs"
        label="Import source"
        activeId={source}
        onSelect={(id) => {
          const next = id as Source;
          setSource(next);
          setStage(next === "local" ? (selection ? "preview" : "source") : "source");
          setMessage("");
        }}
        tabs={[
          { id: "local", label: "Local directory", icon: <Icon name={icons.folderOpened} aria-hidden /> },
          { id: "github", label: "GitHub repository", icon: <Icon name={icons.github} aria-hidden /> }
        ]}
      />

      {stage === "importing" ? (
        <div className="import-progress" aria-live="polite">
          <div className="import-progress__icon"><Icon name={icons.cloudUpload} /></div>
          <h3>Importing your paper</h3>
          <p>{message}</p>
          <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
          <span className="progress-label">{progress}%</span>
        </div>
      ) : source === "local" ? (
        <>
          {!selection ? (
            <div className="directory-picker">
              <Button variant="ghost" className="directory-dropzone" onClick={pickDirectory}>
                <span className="directory-dropzone__icon"><Icon name={icons.folderOpened} /></span>
                <strong>Choose paper directory</strong>
                <span>LaTeX sources, bibliography, figures and style files are copied into FastWrite.</span>
              </Button>
              <Button variant="ghost" className="directory-picker__fallback" onClick={() => inputRef.current?.click()}>Use browser folder upload</Button>
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
              publicationTarget={publicationTarget}
              onName={setProjectName}
              onMain={setMainDocument}
              onVenue={(value) => { setVenue(value); setPublicationTarget(undefined); }}
              onPublicationTarget={setPublicationTarget}
              onChooseAgain={pickDirectory}
            />
          )}
          <FileField inputRef={inputRef} hidden directory multiple label="Paper directory" onSelect={(selected) => void readFallbackFiles(selected)} />
        </>
      ) : (
        <div className="github-form">
          <Field label="Repository URL">
            <TextField value={repository} onChange={setRepository} placeholder="https://github.com/owner/paper" autoFocus />
          </Field>
          <div className="form-grid">
            <Field label={<>Branch, tag or commit <small>optional</small></>}>
              <TextField value={reference} onChange={setReference} placeholder="Default branch" />
            </Field>
            <Field label={<>Project name <small>optional</small></>}>
              <TextField value={projectName} onChange={setProjectName} placeholder="Repository name" />
            </Field>
          </div>
          <div className="form-grid">
            <Field label={<>Main document <small>auto-detect if empty</small></>}>
              <TextField value={mainDocument} onChange={setMainDocument} placeholder="main.tex" />
            </Field>
            <VenueField value={venue} onChange={(value) => { setVenue(value); setPublicationTarget(undefined); }} />
          </div>
          <PublicationTargetFields profile={venue} value={publicationTarget} onChange={setPublicationTarget} />
          <div className="import-note"><Icon name={icons.fileZip} /> The resolved commit is recorded with the imported project.</div>
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
  publicationTarget: PublicationTarget | undefined;
  onName: (value: string) => void;
  onMain: (value: string) => void;
  onVenue: (value: TargetVenue) => void;
  onPublicationTarget: (value: PublicationTarget | undefined) => void;
  onChooseAgain: () => void;
}) {
  return (
    <div className="import-preview">
      <div className="import-summary">
        <div><Icon name={icons.folderOpened} /><span><strong>{props.selection.name}</strong><small>{props.fileCount} files · {formatBytes(props.totalBytes)}</small></span></div>
        <Button variant="ghost" size="small" onClick={props.onChooseAgain}>Choose again</Button>
      </div>
      <div className="form-grid">
        <Field label="Project name">
          <TextField value={props.projectName} onChange={props.onName} />
        </Field>
        <Field label="Main document">
          <Select aria-label="Main document" value={props.mainDocument} onChange={props.onMain} options={props.mainCandidates.map((path) => ({ value: path, label: path }))} />
        </Field>
      </div>
      <VenueField value={props.venue} onChange={props.onVenue} />
      <PublicationTargetFields profile={props.venue} value={props.publicationTarget} onChange={props.onPublicationTarget} />
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
    <Field label="Research domain" hint="The selected domain and publication target guide structure, language, revision, and review.">
      <Select aria-label="Research domain" value={value} onChange={(next) => onChange(next as TargetVenue)} options={WRITING_PROFILES.map((profile) => ({ value: profile.value, label: profile.label }))} />
    </Field>
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
