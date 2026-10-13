export interface DownloadFile {
  blob: Blob;
  filename: string;
}

/** Prefer the UTF-8 filename from the server, then its quoted/plain fallback. */
export function attachmentFilename(disposition: string | null, fallback: string): string {
  const extended = disposition?.match(/(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i);
  const encoded = (extended?.[1] ?? extended?.[2])?.trim();
  if (encoded) {
    const utf8 = encoded.match(/^utf-8'[^']*'(.*)$/i);
    if (utf8) {
      try {
        const filename = safeFilename(decodeURIComponent(utf8[1] ?? ""));
        if (filename) return filename;
      } catch {
        // A malformed extended value must not hide the ordinary filename.
      }
    }
  }
  const plain = disposition?.match(/(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))/i);
  return safeFilename((plain?.[1]?.replace(/\\(.)/g, "$1") ?? plain?.[2] ?? "").trim()) || fallback;
}

function safeFilename(value: string): string {
  return value.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^\.+$/, "") ?? "";
}

/** Download a fetched file without navigating away or exposing its auth token. */
export function downloadFile({ blob, filename }: DownloadFile): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    // Give the browser time to begin consuming the blob before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
