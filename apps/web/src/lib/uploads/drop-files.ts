export interface DroppedFile {
  name: string;
  path: string;
  content: ArrayBuffer;
  type: string;
}

/**
 * Read files from a DataTransfer object (drag-and-drop)
 */
export async function readDroppedFiles(
  transfer: DataTransfer
): Promise<DroppedFile[]> {
  const files: DroppedFile[] = [];
  const items = Array.from(transfer.items);

  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) {
        const content = await readFileAsArrayBuffer(file);
        files.push({
          name: file.name,
          path: file.webkitRelativePath || file.name,
          content,
          type: file.type || "application/octet-stream",
        });
      }
    }
  }

  if (files.length === 0) {
    throw new Error("No files were dropped");
  }

  return files;
}

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read file as ArrayBuffer"));
      }
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsArrayBuffer(file);
  });
}
