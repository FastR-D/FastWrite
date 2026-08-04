export const FASTWRITE_SAVE_EVENT = "fastwrite:save";

export function isSaveShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s";
}
