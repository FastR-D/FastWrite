import { api, ApiClientError } from "../api/client";
import { downloadFile } from "../api/download";

export async function downloadProjectArchive(projectId: string, signal?: AbortSignal): Promise<void> {
  const file = await api.projects.exportArchive(projectId, signal);
  signal?.throwIfAborted();
  downloadFile(file);
}

export function projectExportErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return "Your session has expired. Sign in again to export the source files.";
    if (error.status === 403) return "You do not have permission to export this project's source files.";
  }
  return error instanceof Error ? `Could not export source files: ${error.message}` : "Could not export source files. Please try again.";
}
