import { useEffect, useState } from "react";
import { ProjectsPage } from "./pages/ProjectsPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { UiGalleryPage } from "./pages/UiGalleryPage";

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
  return route.name === "workspace" ? <WorkspacePage projectId={route.projectId} /> : route.name === "gallery" ? <UiGalleryPage /> : <ProjectsPage />;
}
