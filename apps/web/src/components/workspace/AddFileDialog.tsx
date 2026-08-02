import { useEffect, useState } from "react";
import { UploadCloud } from "lucide-react";
import { api } from "../../api/client";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

interface AddFileDialogProps {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onAdded: (path: string) => void | Promise<void>;
}

export function AddFileDialog({ open, projectId, onClose, onAdded }: AddFileDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setPath("");
    setError("");
  }, [open]);

  const upload = async () => {
    if (!file || !path.trim()) return;
    setLoading(true);
    setError("");
    try {
      const added = await api.projects.addFile(projectId, path.trim(), file);
      await onAdded(added.path);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not add file");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} title="Add a file" description="The selected file is copied into this managed Workspace." onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<UploadCloud />} loading={loading} disabled={!file || !path.trim()} onClick={() => void upload()}>Add file</Button></>}>
      <div className="form-stack">
        <label className="field"><span>Source file</span><input className="file-input" type="file" onChange={(event) => { const selected = event.target.files?.[0] ?? null; setFile(selected); if (selected) setPath(selected.name); }} /></label>
        <label className="field"><span>Workspace path</span><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="figures/architecture.png" /></label>
      </div>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
    </Dialog>
  );
}
