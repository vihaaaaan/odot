import { createRemoteJWKSet, jwtVerify } from "jose";
import { AuthenticationError } from "../shared/errors.js";
import { userIdInput } from "../shared/validation.js";

export function createNeonTokenVerifier(authUrl: string) {
  const baseUrl = new URL(authUrl);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("Neon Auth requires an HTTPS base URL without credentials, query, or fragment");
  }
  const keys = createRemoteJWKSet(new URL(`${baseUrl.href.replace(/\/$/, "")}/.well-known/jwks.json`));
  return async (token: string): Promise<string> => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: baseUrl.origin,
        audience: baseUrl.origin,
        algorithms: ["EdDSA"],
        requiredClaims: ["sub", "exp", "iat"],
        maxTokenAge: "15m",
      });
      if (payload.banned === true) throw new AuthenticationError();
      return userIdInput.parse(payload.sub);
    } catch {
      throw new AuthenticationError();
    }
  };
}
