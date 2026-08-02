import { useEffect, useMemo, useState } from "react";
import { Download, Save } from "lucide-react";
import { isIgnoredWorkspacePath, WRITING_PROFILES, type PaperProject, type WritingProfile, type WorkspaceTreeNode } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

interface ProjectSettingsDialogProps {
  open: boolean;
  project: PaperProject;
  tree: WorkspaceTreeNode[];
  onClose: () => void;
  onSaved: (project: PaperProject) => void | Promise<void>;
}

export function ProjectSettingsDialog({ open, project, tree, onClose, onSaved }: ProjectSettingsDialogProps) {
  const [name, setName] = useState(project.name);
  const [mainDocument, setMainDocument] = useState(project.mainDocument);
  const [profile, setProfile] = useState<WritingProfile>(project.skill.venue);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const texFiles = useMemo(() => flattenFiles(tree).filter((path) => path.toLowerCase().endsWith(".tex") && !isIgnoredWorkspacePath(path)), [tree]);

  useEffect(() => {
    if (!open) return;
    setName(project.name);
    setMainDocument(texFiles.includes(project.mainDocument) ? project.mainDocument : preferredMainDocument(texFiles));
    setProfile(project.skill.venue);
    setError("");
  }, [open, project, texFiles]);

  const save = async () => {
    setLoading(true);
    setError("");
    try {
      const updated = await api.projects.update(project.id, { name: name.trim(), mainDocument, venue: profile });
      await onSaved(updated);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not update project");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Project settings"
      description="Configure the paper entry point and the Writing Skill used by Agent, Revise, and Review."
      width="small"
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Save />} loading={loading} disabled={!name.trim() || !mainDocument} onClick={() => void save()}>Save changes</Button></>}
    >
      <div className="settings-fields">
        <label className="field"><span>Project name</span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
        <label className="field"><span>Main document</span><select value={mainDocument} onChange={(event) => setMainDocument(event.target.value)}>{texFiles.map((path) => <option key={path} value={path}>{path}</option>)}</select></label>
        <label className="field"><span>Writing profile</span><select value={profile} onChange={(event) => setProfile(event.target.value as WritingProfile)}>{WRITING_PROFILES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <div className="settings-export"><div><strong>Automatic Git history</strong><span>Every accepted save is committed inside the managed workspace. FastWrite never writes backups into the imported source folder.</span></div></div>
        <div className="settings-export"><div><strong>Workspace snapshot</strong><span>Download all source files as a portable tar.gz archive.</span></div><a className="button button--secondary button--medium" href={api.projects.exportUrl(project.id)} download><Download />Export</a></div>
      </div>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
    </Dialog>
  );
}

function flattenFiles(nodes: WorkspaceTreeNode[]): string[] {
  return nodes.flatMap((node) => node.type === "file" ? [node.path] : flattenFiles(node.children));
}

function preferredMainDocument(paths: string[]): string {
  return paths.find((path) => ["main.tex", "paper.tex", "document.tex"].includes(path.split("/").at(-1)?.toLowerCase() ?? "")) ?? paths[0] ?? "";
}
