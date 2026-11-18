import { existsSync } from "fs";
import { apiLog } from "./cursor-api-logger";
import type { AuthInfo, CursorHeaders } from "./cursor-api-types";
import { getGlobalCursorDbPath, type CursorAuthValues } from "./cursor-db-reader";
import { readCursorAuthValues } from "./db-worker-client";
import { openCursorAuthSecret } from "./cursor-safe-storage";
import { invalidateSetupCache } from "./cursor-setup-cache";

// TTL corto: la lettura DB è ora nel worker, ma una finestra troppo larga
// maschererebbe un cambio token (invalidateSetupCache ritardato).
const AUTH_CACHE_TTL = 5_000;

let cachedAuth: { info: AuthInfo | null; ts: number; sessionToken: string | null } = {
  info: null,
  ts: 0,
  sessionToken: null,
};

// Azzera la cache auth: permette ai test di isolare i casi e a chi usa il
// modulo di forzare una rilettura esplicita del DB.
export function resetCursorAuthCache(): void {
  cachedAuth = { info: null, ts: 0, sessionToken: null };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseUserIdFromJwt(jwt: string): string | null {
  const payload = decodeJwtPayload(jwt);
  if (!payload) return null;
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const parts = sub.split("|");
  return parts.length > 1 ? parts[1]! : sub || null;
}

export async function getCursorToken(): Promise<AuthInfo | null> {
  const dbPath = getGlobalCursorDbPath();

  if (!existsSync(dbPath)) {
    apiLog("Database file does not exist");
    return null;
  }

  // The DB scan below is synchronous and expensive: serve the cached token
  // first so a refresh cycle does not re-read state.vscdb on every call.
  if (cachedAuth.info && Date.now() - cachedAuth.ts < AUTH_CACHE_TTL) {
    apiLog("Using cached auth token");
    return cachedAuth.info;
  }

  let authValues: CursorAuthValues;
  try {
    authValues = await readCursorAuthValues(dbPath);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiLog(`Could not read accessToken from database: ${msg}`);
    return null;
  }

  const stored = authValues["cursorAuth/accessToken"] ?? null;
  if (!stored) {
    apiLog("No accessToken found in database");
    return null;
  }

  let jwt: string;
  try {
    jwt = await openCursorAuthSecret(stored);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Could not decrypt sealed token";
    apiLog(`Could not open accessToken: ${msg}`);
    return null;
  }

  const userId = parseUserIdFromJwt(jwt);
  if (!userId) {
    apiLog("Could not parse userId from JWT");
    return null;
  }

  const sessionToken = `${userId}%3A%3A${jwt}`;

  if (cachedAuth.sessionToken !== sessionToken) {
    apiLog("Auth token changed; invalidating setup cache");
    invalidateSetupCache();
  }

  apiLog(`DB path: ${dbPath}`);
  apiLog(`Found JWT token (${jwt.length} chars)`);
  apiLog(`Parsed userId: ${userId}`);

  const email = authValues["cursorAuth/cachedEmail"] ?? null;
  apiLog(`Cached email: ${email}`);

  const info = { userId, accessToken: jwt, sessionToken, email };
  cachedAuth = { info, ts: Date.now(), sessionToken };
  return info;
}

export function cursorHeaders(sessionToken: string): CursorHeaders {
  return {
    "Content-Type": "application/json",
    Cookie: `WorkosCursorSessionToken=${sessionToken}`,
    Origin: "https://cursor.com",
    Referer: "https://cursor.com/dashboard",
  };
}
