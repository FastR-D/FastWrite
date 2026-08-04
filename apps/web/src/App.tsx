import { useEffect, useState } from "react";
import { ProjectsPage } from "./pages/ProjectsPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { UiGalleryPage } from "./pages/UiGalleryPage";
import { FASTWRITE_SAVE_EVENT, isSaveShortcut } from "./lib/keyboard";

function routeFromLocation(): { name: "projects" } | { name: "gallery" } | { name: "workspace"; projectId: string } {
  if (window.location.pathname === "/components") return { name: "gallery" };
  const match = window.location.pathname.match(/^\/projects\/([^/]+)\/?$/);
  if (match?.[1]) return { name: "workspace", projectId: decodeURIComponent(match[1]) };
  return { name: "projects" };
}

export function App() {
  const [route, setRoute] = useState(routeFromLocation);
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
  return route.name === "workspace" ? <WorkspacePage projectId={route.projectId} /> : route.name === "gallery" ? <UiGalleryPage /> : <ProjectsPage />;
}
