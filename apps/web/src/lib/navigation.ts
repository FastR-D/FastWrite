import { appPath } from "./appBase";

export function navigate(path: string): void {
  window.history.pushState({}, "", appPath(path));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function projectPath(projectId: string): string {
  return appPath(`/projects/${encodeURIComponent(projectId)}`);
}
