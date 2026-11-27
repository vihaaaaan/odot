import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError, createNeonTokenVerifier } from "../src/index.js";

const authUrl = "https://auth.example.test/neondb/auth";
const origin = new URL(authUrl).origin;

afterEach(() => vi.unstubAllGlobals());

async function tokenFixture() {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "EdDSA", use: "sig" };
  const fetchKeys = vi.fn(async (_input: unknown) => new Response(JSON.stringify({ keys: [jwk] }), {
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchKeys);
  const now = Math.floor(Date.now() / 1000);
  const sign = (overrides: Record<string, unknown> = {}) => new SignJWT({
    sub: "neon-user-123", iss: origin, aud: origin, iat: now, exp: now + 900, ...overrides,
  }).setProtectedHeader({ alg: "EdDSA", kid: "test-key" }).sign(privateKey);
  return { sign, fetchKeys, verify: createNeonTokenVerifier(authUrl), now };
}

describe("Neon Auth JWT verification", () => {
  it("verifies the signature and returns the subject, never an email or a caller-supplied owner", async () => {
    const { sign, verify, fetchKeys } = await tokenFixture();
    expect(await verify(await sign({ email: "someone@example.test", id: "not-the-subject" }))).toBe("neon-user-123");
    expect(String(fetchKeys.mock.calls[0]?.[0])).toBe(`${authUrl}/.well-known/jwks.json`);
  });

  it("rejects wrong issuers, wrong audiences, expiration, future tokens, missing claims, and banned users", async () => {
    const { sign, verify, now } = await tokenFixture();
    const invalidClaims: Record<string, unknown>[] = [
      { iss: "https://other.example.test" }, { aud: "https://other.example.test" },
      { exp: now - 1 }, { iat: now + 60 }, { sub: "" }, { sub: undefined },
      { exp: undefined }, { iat: undefined }, { banned: true }, { iat: now - 901, exp: now + 100 },
    ];
    for (const claims of invalidClaims) {
      await expect(verify(await sign(claims))).rejects.toBeInstanceOf(AuthenticationError);
    }
  });

  it("rejects tokens signed by another key, symmetric algorithms, malformed tokens, and key-service failures", async () => {
    const { verify, sign } = await tokenFixture();
    const { privateKey } = await generateKeyPair("EdDSA");
    const forged = await new SignJWT({ sub: "attacker" }).setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
      .setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("15m").sign(privateKey);
    const symmetric = await new SignJWT({ sub: "attacker" }).setProtectedHeader({ alg: "HS256" })
      .setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("15m").sign(new Uint8Array(32));
    for (const token of [forged, symmetric, "", "not-a-jwt"]) {
      await expect(verify(token)).rejects.toBeInstanceOf(AuthenticationError);
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(createNeonTokenVerifier(authUrl)(await sign())).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("requires an HTTPS configuration without URL credentials or unexpected query parameters", () => {
    for (const url of ["http://localhost/auth", "https://user:secret@auth.example.test", `${authUrl}?other=1`]) {
      expect(() => createNeonTokenVerifier(url)).toThrow();
    }
  });
});
