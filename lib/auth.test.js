// Run with: npm test
// Checks that only real, unexpired tokens for our Firebase project are accepted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyIdToken } from "./auth.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const certs = async () => ({ key1: publicKey.export({ type: "spki", format: "pem" }) });
const now = Math.floor(Date.now() / 1000);

function makeToken(payload, { kid = "key1", key = privateKey } = {}) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", kid })}.${part(payload)}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
}
const good = { aud: "tinker-app", iss: "https://securetoken.google.com/tinker-app", sub: "user123", iat: now - 10, exp: now + 3600 };

test("a valid token returns the user id", async () => {
  assert.equal(await verifyIdToken(makeToken(good), "tinker-app", certs), "user123");
});

test("bad tokens are rejected", async () => {
  assert.equal(await verifyIdToken(makeToken({ ...good, exp: now - 1 }), "tinker-app", certs), null, "expired");
  assert.equal(await verifyIdToken(makeToken({ ...good, aud: "someone-else" }), "tinker-app", certs), null, "other project");
  assert.equal(await verifyIdToken(makeToken(good, { key: otherKey }), "tinker-app", certs), null, "forged signature");
  assert.equal(await verifyIdToken(makeToken(good, { kid: "unknown" }), "tinker-app", certs), null, "unknown key");
  assert.equal(await verifyIdToken("not.a.token", "tinker-app", certs), null, "garbage");
  assert.equal(await verifyIdToken(makeToken(good), "", certs), null, "no project configured");
});
