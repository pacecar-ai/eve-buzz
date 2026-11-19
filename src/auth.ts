import { getVercelOidcToken } from "@vercel/oidc";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { actionKeyHeader, type ProjectIdentity } from "./protocol.ts";

const issuers = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function fromProject(request: Request, project: ProjectIdentity): Promise<boolean> {
  const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token || token.length > 8192) return false;
  const hub = "https://oidc.vercel.com";
  const issuer = project.issuerMode === "team" ? `${hub}/${project.teamSlug}` : hub;
  let keys = issuers.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`), { timeoutDuration: 4000 });
    issuers.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: `https://vercel.com/${project.teamSlug}`,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "owner_id", "project_id", "environment"],
      clockTolerance: 5,
    });
    return payload.owner_id === project.teamId && payload.project_id === project.projectId
      && payload.environment === project.environment;
  } catch {
    return false;
  }
}

export async function postToProject(baseUrl: string, path: string, body: unknown, actionKey?: string): Promise<Response> {
  const token = await getVercelOidcToken();
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-vercel-trusted-oidc-idp-token": token,
  });
  if (actionKey) headers.set(actionKeyHeader, actionKey);
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
    redirect: "error",
  });
}
