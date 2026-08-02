import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvironmentFile(path: string, target: NodeJS.ProcessEnv = process.env): boolean {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match?.[1] || target[match[1]] !== undefined) continue;
    target[match[1]] = parseEnvironmentValue(match[2] ?? "");
  }
  return true;
}

export function loadProjectEnvironment(target: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    target.FASTWRITE_ENV_FILE,
    resolve(import.meta.dir, "../../..", ".env"),
    resolve(process.cwd(), ".env")
  ].filter((path): path is string => Boolean(path));
  for (const path of [...new Set(candidates)]) if (loadEnvironmentFile(path, target)) return path;
  return null;
}

function parseEnvironmentValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll("\\n", "\n").replaceAll("\\r", "\r").replaceAll("\\t", "\t").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, "").trim();
}
