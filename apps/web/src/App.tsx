import { lazy, Suspense, useEffect, useState } from "react";
import { FASTWRITE_SAVE_EVENT, isSaveShortcut } from "./lib/keyboard";
import { applyTheme, initialTheme } from "./lib/theme";

const ProjectsPage = lazy(() => import("./pages/ProjectsPage").then((module) => ({ default: module.ProjectsPage })));
const WorkspacePage = lazy(() => import("./pages/WorkspacePage").then((module) => ({ default: module.WorkspacePage })));
const UiGalleryPage = lazy(() => import("./pages/UiGalleryPage").then((module) => ({ default: module.UiGalleryPage })));

function routeFromLocation(): { name: "projects" } | { name: "gallery" } | { name: "workspace"; projectId: string } {
  if (window.location.pathname === "/components") return { name: "gallery" };
  const match = window.location.pathname.match(/^\/projects\/([^/]+)\/?$/);
  if (match?.[1]) return { name: "workspace", projectId: decodeURIComponent(match[1]) };
  return { name: "projects" };
}

export function App() {
  const [route, setRoute] = useState(routeFromLocation);
  useEffect(() => { applyTheme(initialTheme()); }, []);
  useEffect(() => {
    const update = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new Event(FASTWRITE_SAVE_EVENT));
    };
    window.addEventListener("keydown", save, { capture: true });
    return () => window.removeEventListener("keydown", save, { capture: true });
  }, []);
  const page = route.name === "workspace" ? <WorkspacePage projectId={route.projectId} /> : route.name === "gallery" ? <UiGalleryPage /> : <ProjectsPage />;
  return <Suspense fallback={<main className="app-loading" aria-live="polite">Loading FastWrite…</main>}>{page}</Suspense>;
}
