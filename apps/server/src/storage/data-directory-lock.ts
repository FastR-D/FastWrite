import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Shared by the server and offline maintenance commands. Release only when all writers stop. */
export function lockDataDirectory(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, ".fastwrite-process.lock");
  const identity = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
  try { writeFileSync(path, identity, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Data directory is locked. Stop FastWrite before restoring. Remove .fastwrite-process.lock only after verifying that all processes using this directory have stopped.");
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (readFileSync(path, "utf8") === identity) unlinkSync(path);
  };
}
