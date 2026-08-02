export function logServerError(context: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
  console.error(`[FastWrite] ${context}`, { name, ...(code ? { code } : {}) });
}
