// Saves terminal chats so `tinker --resume` can continue where you left off.
// Each chat is one JSON file in ~/.tinker/sessions/, remembering which folder it was started in.

import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const SESSIONS_DIR = join(homedir(), ".tinker", "sessions");
const KEEP = 30; // only the newest 30 chats are kept

export async function saveSession(session, dir = SESSIONS_DIR) {
  await mkdir(dir, { recursive: true });
  session.updated = new Date().toISOString();
  await writeFile(join(dir, `${session.id}.json`), JSON.stringify(session, null, 2));

  // Remove the oldest chats beyond the limit.
  const all = await listSessions(dir);
  await Promise.all(all.slice(KEEP).map((old) => rm(join(dir, `${old.id}.json`), { force: true })));
}

// All saved chats, newest first. Broken files are skipped.
export async function listSessions(dir = SESSIONS_DIR) {
  const files = await readdir(dir).catch(() => []);
  const sessions = await Promise.all(
    files.filter((f) => f.endsWith(".json")).map((f) => readFile(join(dir, f), "utf8").then(JSON.parse).catch(() => null)),
  );
  return sessions.filter((s) => s?.id && Array.isArray(s.messages)).sort((a, b) => b.updated.localeCompare(a.updated));
}

// The most recent chat started in this folder (each project has its own history).
export async function latestSession(folder, dir = SESSIONS_DIR) {
  return (await listSessions(dir)).find((s) => s.folder === folder) || null;
}
