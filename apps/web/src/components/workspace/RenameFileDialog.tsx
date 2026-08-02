import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { api } from "../../api/client";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

interface RenameFileDialogProps {
  open: boolean;
  projectId: string;
  path: string;
  onClose: () => void;
  onRenamed: (path: string) => void | Promise<void>;
}

export function RenameFileDialog({ open, projectId, path, onClose, onRenamed }: RenameFileDialogProps) {
  const [nextPath, setNextPath] = useState(path);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setNextPath(path);
      setError("");
    }
  }, [open, path]);

  const rename = async () => {
    const normalized = nextPath.trim();
    if (!normalized || normalized === path) return;
    setLoading(true);
    setError("");
    try {
      await api.projects.renameFile(projectId, path, normalized);
      await onRenamed(normalized);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : "Could not rename file");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Rename file"
      description="Move the file by including a directory in its new workspace-relative path."
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Pencil />} loading={loading} disabled={!nextPath.trim() || nextPath.trim() === path} onClick={() => void rename()}>Rename</Button></>}
    >
      <label className="field"><span>New path</span><input value={nextPath} onChange={(event) => setNextPath(event.target.value)} autoFocus /></label>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
    </Dialog>
  );
}
