// Terminal account: `tinker login`, keeping the sign-in fresh, and saving terminal chats to your account.
// The sign-in key (a Firebase "refresh token") is stored in ~/.tinker/auth.json, readable only by you.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// Public Firebase web config (the same one the website uses; not a secret).
const FIREBASE = { apiKey: "AIzaSyAK2ooD81mvhgGXrEyvRn5tT7GDpBbhs4A", projectId: process.env.FIREBASE_PROJECT_ID || "tinkeraidev" };
export const AUTH_PATH = join(homedir(), ".tinker", "auth.json");

let session = null; // { idToken, uid, expiresAt }

export async function loadAuth() {
  try {
    return JSON.parse(await readFile(AUTH_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function saveAuth(auth) {
  await mkdir(dirname(AUTH_PATH), { recursive: true });
  await writeFile(AUTH_PATH, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export async function logout() {
  session = null;
  await rm(AUTH_PATH, { force: true });
}

// A fresh ID token (they last an hour). Returns null if not logged in or the sign-in was revoked.
export async function idToken() {
  if (session && Date.now() < session.expiresAt - 60_000) return session.idToken;
  const auth = await loadAuth();
  if (!auth?.refreshToken) return null;
  const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refreshToken }),
  });
  if (!response.ok) {
    if (response.status === 400) await logout(); // revoked, account deleted or password changed
    return null;
  }
  const data = await response.json();
  session = { idToken: data.id_token, uid: data.user_id, expiresAt: Date.now() + Number(data.expires_in) * 1000 };
  if (data.refresh_token && data.refresh_token !== auth.refreshToken) await saveAuth({ ...auth, refreshToken: data.refresh_token });
  return session.idToken;
}

// ---------- tinker login ----------

export async function login(server, { print, openBrowser }) {
  const start = await fetch(`${server}/api/cli-login/start`, { method: "POST" });
  if (!start.ok) throw new Error("Couldn't start login. Is the Tinker server reachable?");
  const { code, pollToken } = await start.json();
  const url = `${server}/cli-login?code=${code}`;
  print(code, url);
  openBrowser(url);

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const poll = await fetch(`${server}/api/cli-login/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, pollToken }),
    }).catch(() => null);
    if (!poll || poll.status === 202) continue;
    if (!poll.ok) throw new Error("The login code expired. Run tinker login again.");
    const { refreshToken, email } = await poll.json();
    await saveAuth({ refreshToken, email });
    session = null;
    if (!(await idToken())) throw new Error("Signed in, but couldn't confirm the account. Try again.");
    return { email };
  }
  throw new Error("Login timed out after 5 minutes. Run tinker login again.");
}

// ---------- Saving chats to Firestore (same place the web app saves them) ----------

// Firestore's web API wants typed values: { stringValue: "hi" }, { arrayValue: { values: [...] } }, …
export function toFirestore(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestore) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toFirestore(v)])) } };
}

export async function saveChatToAccount(chat) {
  const token = await idToken();
  if (!token) return false;
  const path = `projects/${FIREBASE.projectId}/databases/(default)/documents/users/${session.uid}/chats/${chat.id}`;
  const response = await fetch(`https://firestore.googleapis.com/v1/${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: toFirestore(chat).mapValue.fields }),
  });
  return response.ok;
}
