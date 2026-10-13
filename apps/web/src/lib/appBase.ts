/** Keep browser routes and requests within the configured Vite deployment path. */
export function normalizeAppBase(base: string): string {
  const path = base.trim().replace(/^\/+|\/+$/g, "");
  return path ? `/${path}` : "";
}

export const APP_BASE = normalizeAppBase(import.meta.env?.BASE_URL ?? "/");

export function appPath(path: string, base = APP_BASE): string {
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  if (!base || path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`) || path.startsWith(`${base}#`)) return path;
  return `${base}${path}`;
}

export function relativeAppPath(path: string, base = APP_BASE): string {
  if (!base) return path;
  if (path === base || path === `${base}/`) return "/";
  return path.startsWith(`${base}/`) ? path.slice(base.length) : path;
}
