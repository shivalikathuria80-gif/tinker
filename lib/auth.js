// Checks Firebase sign-in tokens on the server, so limits can be per person.
// A Firebase "ID token" is a JWT signed by Google. We verify the signature with Google's public
// certificates (no secret key needed) and check it was made for our Firebase project.

import { createPublicKey, verify } from "node:crypto";

const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
let certCache = { certs: null, expires: 0 };

// Google rotates these keys; the response says how long they can be cached.
async function googleCerts() {
  if (certCache.certs && Date.now() < certCache.expires) return certCache.certs;
  const response = await fetch(CERTS_URL);
  if (!response.ok) throw new Error("Couldn't load Google's sign-in certificates");
  const maxAge = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1] || 3600);
  certCache = { certs: await response.json(), expires: Date.now() + maxAge * 1000 };
  return certCache.certs;
}

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

// Returns the user's id (uid) if the token is valid, otherwise null.
export async function verifyIdToken(token, projectId, getCerts = googleCerts) {
  try {
    if (!token || !projectId) return null;
    const [headerPart, payloadPart, signaturePart] = token.split(".");
    const header = decode(headerPart);
    const payload = decode(payloadPart);
    const now = Math.floor(Date.now() / 1000);

    if (header.alg !== "RS256") return null;
    if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
    if (!payload.sub || payload.exp <= now || payload.iat > now + 60) return null;

    const cert = (await getCerts())[header.kid];
    if (!cert) return null;
    const signedPart = Buffer.from(`${headerPart}.${payloadPart}`);
    const valid = verify("RSA-SHA256", signedPart, createPublicKey(cert), Buffer.from(signaturePart, "base64url"));
    return valid ? payload.sub : null;
  } catch {
    return null; // broken token
  }
}
