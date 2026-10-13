import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { Button, Dialog, Field, FileField, Icon, icons, TextField } from "../ui";
import type { DroppedFile } from "../../lib/uploads/drop-files";

interface AddFileDialogProps {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onAdded: (path: string, targetKind?: "skill-resource" | "reference-artifact") => void | Promise<void>;
  initialFiles?: DroppedFile[];
  targetPath?: string;
}

export function AddFileDialog({ open, projectId, onClose, onAdded, initialFiles, targetPath }: AddFileDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    if (initialFiles && initialFiles.length > 0) {
      const dropped = initialFiles[0];
      if (dropped) {
        // Convert ArrayBuffer back to File
        const blob = new Blob([dropped.content], { type: dropped.type });
        const fileObj = new File([blob], dropped.name, { type: dropped.type });
        setFile(fileObj);
        setPath(dropped.path);
      }
    } else {
      setFile(null);
      setPath(targetPath || "");
    }
    setError("");
  }, [open, initialFiles, targetPath]);

  const upload = async () => {
    if (!file || !path.trim()) return;
    setLoading(true);
    setError("");
    try {
      const added = await api.projects.addFile(projectId, path.trim(), file);
      await onAdded(added.path);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "无法添加文件");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} title="添加文件" description="所选文件将复制到此工作区。" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" icon={<Icon name={icons.cloudUpload} />} loading={loading} disabled={!file || !path.trim()} onClick={() => void upload()}>添加文件</Button></>}>
      <div className="form-stack">
        <Field label="源文件">
          <FileField label="源文件" onSelect={(files) => { const selected = files[0] ?? null; setFile(selected); if (selected) setPath(selected.name); }} />
        </Field>
        <Field label="工作区路径">
          <TextField value={path} onChange={setPath} placeholder="figures/architecture.png" />
        </Field>
      </div>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
    </Dialog>
  );
}
