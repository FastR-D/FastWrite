import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { Button, Dialog, Field, Icon, icons, TextField } from "../ui";

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
      setError(renameError instanceof Error ? renameError.message : "无法重命名文件");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="重命名文件"
      description="在新的工作区相对路径中填写目录，即可移动文件。"
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" icon={<Icon name={icons.edit} />} loading={loading} disabled={!nextPath.trim() || nextPath.trim() === path} onClick={() => void rename()}>重命名</Button></>}
    >
      <Field label="新路径">
        <TextField value={nextPath} onChange={setNextPath} autoFocus />
      </Field>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
    </Dialog>
  );
}
