import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { FASTWRITE_SAVE_EVENT, isSaveShortcut } from "./lib/keyboard";
import { applyTheme, initialTheme } from "./lib/theme";
import { api } from "./api/client";
import { Button, Link } from "./components/ui";
import { appPath, relativeAppPath } from "./lib/appBase";

const ProjectsPage = lazy(() => import("./pages/ProjectsPage").then((module) => ({ default: module.ProjectsPage })));
const DiagramsPage = lazy(() => import("./pages/DiagramsPage").then((module) => ({ default: module.DiagramsPage })));
const WorkspacePage = lazy(() => import("./pages/WorkspacePage").then((module) => ({ default: module.WorkspacePage })));
const GalleryPage = lazy(() => import("./pages/GalleryPage").then((module) => ({ default: module.GalleryPage })));
const SharedReviewPage = lazy(() => import("./pages/SharedReviewPage").then((module) => ({ default: module.SharedReviewPage })));
const AccessRequestPage = lazy(() => import("./pages/AccessRequestPage").then((module) => ({ default: module.AccessRequestPage })));
const AdminPage = lazy(() => import("./pages/AdminPage").then((module) => ({ default: module.AdminPage })));

function routeFromLocation(): { name: "admin" } | { name: "diagrams" } | { name: "projects" } | { name: "gallery" } | { name: "workspace"; projectId: string } | { name: "shared"; token: string } | { name: "access-request"; projectId: string } {
  const pathname = relativeAppPath(window.location.pathname);
  if (pathname === "/admin") return { name: "admin" };
  if (pathname === "/diagrams") return { name: "diagrams" };
  if (pathname === "/components") return { name: "gallery" };
  const shared = pathname.match(/^\/shared\/([^/]+)\/?$/);
  if (shared?.[1]) return { name: "shared", token: decodeURIComponent(shared[1]) };
  const accessRequest = pathname.match(/^\/request-access\/([^/]+)\/?$/);
  if (accessRequest?.[1]) return { name: "access-request", projectId: decodeURIComponent(accessRequest[1]) };
  const match = pathname.match(/^\/projects\/([^/]+)\/?$/);
  if (match?.[1]) return { name: "workspace", projectId: decodeURIComponent(match[1]) };
  return { name: "projects" };
}

function AppLoading({ message = "Loading FastWrite…", failed = false }: { message?: string; failed?: boolean }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 15_000);
    return () => window.clearTimeout(timer);
  }, []);
  return <main className="app-loading" aria-live="polite"><div style={{ display: "grid", gap: 12, textAlign: "center", maxWidth: 480, padding: 24 }}>
    <h1 style={{ margin: 0 }}>FastWrite</h1>
    <p style={{ margin: 0 }}>{message}</p>
    {(failed || slow) && <><p style={{ margin: 0 }}>Check your connection, then reload to try again.</p><Button onClick={() => window.location.reload()}>Reload FastWrite</Button></>}
  </div></main>;
}

class PageLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <AppLoading failed message="FastWrite could not load this page." /> : this.props.children;
  }
}

export function App() {
  const [route, setRoute] = useState(routeFromLocation);
  const [authenticationReady, setAuthenticationReady] = useState(() => {
    const parameters = new URLSearchParams(window.location.search);
    return !["oidc", "cas", "fastcas"].some((provider) => parameters.get(provider) === "complete");
  });
  useEffect(() => { applyTheme(initialTheme()); }, []);
  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    if (parameters.get("oidc") !== "complete" && parameters.get("cas") !== "complete" && parameters.get("fastcas") !== "complete") return;
    void api.auth.refresh().then((session) => {
      localStorage.setItem("fastwrite.session-token", session.token);
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }).catch(() => window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`))
      .finally(() => setAuthenticationReady(true));
  }, []);
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
      const dialog = event.target instanceof Element ? event.target.closest('[role="dialog"]') : null;
      if (dialog) {
        const command = dialog.querySelector<HTMLButtonElement>("button[data-save-command]");
        if (command && !command.disabled) command.click();
        return;
      }
      window.dispatchEvent(new Event(FASTWRITE_SAVE_EVENT));
    };
    window.addEventListener("keydown", save, { capture: true });
    return () => window.removeEventListener("keydown", save, { capture: true });
  }, []);
  if (!authenticationReady) return <AppLoading message="Completing sign-in…" />;
  const page = route.name === "admin" ? <AdminPage /> : route.name === "diagrams" ? <DiagramsPage /> : route.name === "workspace" ? <WorkspacePage projectId={route.projectId} /> : route.name === "shared" ? <SharedReviewPage token={route.token} /> : route.name === "access-request" ? <AccessRequestPage projectId={route.projectId} /> : route.name === "gallery" ? <GalleryPage /> : <ProjectsPage />;
  const routeKey = "projectId" in route ? `${route.name}:${route.projectId}` : "token" in route ? `${route.name}:${route.token}` : route.name;
  return <PageLoadBoundary key={routeKey}><Suspense fallback={<AppLoading />}>{route.name !== "diagrams" && <Link href={appPath("/diagrams")} style={{position:"fixed",bottom:18,right:24,zIndex:100,background:"#244f3d",color:"white",padding:"10px 18px",borderRadius:8}}>科研绘图</Link>}{page}</Suspense></PageLoadBoundary>;
}
