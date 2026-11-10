import { initColorMode } from "@fastrd/ui-foundation";

export type Theme = "light" | "dark";

const STORAGE_KEY = "fastwrite.theme";
export const THEME_CHANGE_EVENT = "fastwrite-theme-change";
const colorMode = initColorMode({ storageKey: STORAGE_KEY });

function syncTheme(): void {
  // Existing editor/chrome selectors belong to the host; resolution belongs to foundation.
  document.documentElement.dataset.theme = colorMode.resolved;
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}
syncTheme();
colorMode.subscribe(syncTheme);

export function currentTheme(): Theme {
  return colorMode.resolved;
}

export function applyTheme(theme: Theme): void {
  colorMode.setMode(theme);
}
