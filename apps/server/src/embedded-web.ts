export function embeddedWebFile(path: string): Blob | null {
  const exact = Bun.embeddedFiles.find((file) => embeddedName(file) === path);
  return exact ?? Bun.embeddedFiles.find((file) => embeddedName(file).endsWith(`/${path}`)) ?? null;
}

function embeddedName(file: Blob): string {
  return (file as Blob & { name?: string }).name ?? "";
}
