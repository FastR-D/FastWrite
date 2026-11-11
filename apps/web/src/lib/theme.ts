import { initColorMode } from "@fastrd/ui-foundation";

export type Theme = "light" | "dark";

const STORAGE_KEY = "fastwrite.theme";
export const THEME_CHANGE_EVENT = "fastwrite-theme-change";
let colorMode: ReturnType<typeof initColorMode>;

export function initTheme(): void {
  if (colorMode) return;
  colorMode = initColorMode({ storageKey: STORAGE_KEY });
  colorMode.subscribe(syncTheme);
}

function syncTheme(): void {
  // Existing editor/chrome selectors belong to the host; resolution belongs to foundation.
  document.documentElement.dataset.theme = colorMode.resolved;
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

export function currentTheme(): Theme {
  // Server rendering uses the default palette; main initializes the browser before rendering.
  return colorMode?.resolved ?? "light";
}

export function applyTheme(theme: Theme): void {
  colorMode.setMode(theme);
}
