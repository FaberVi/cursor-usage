/**
 * Saves sanitized API fixtures to test/fixtures/ for regression tests.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { readCursorAuthValuesFromDb } from "../src/cursor-api";
import { openCursorAuthSecret } from "../src/cursor-safe-storage";

const dbPath = join(
  process.env.APPDATA ?? join(homedir(), "AppData/Roaming"),
  "Cursor/User/globalStorage/state.vscdb",
);

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1]!;
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString()) as Record<string, unknown>;
}

const authValues = readCursorAuthValuesFromDb(dbPath);
const rawToken = authValues["cursorAuth/accessToken"];
if (!rawToken) throw new Error("No accessToken");
const jwt = await openCursorAuthSecret(rawToken);

const sub = typeof decodeJwtPayload(jwt).sub === "string" ? decodeJwtPayload(jwt).sub as string : "";
const userId = sub.split("|")[1] ?? sub;
const headers = {
  "Content-Type": "application/json",
  Cookie: `WorkosCursorSessionToken=${userId}%3A%3A${jwt}`,
  Origin: "https://cursor.com",
  Referer: "https://cursor.com/dashboard",
};

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
mkdirSync(outDir, { recursive: true });

async function save(name: string, res: Response): Promise<unknown | null> {
  const body = res.ok ? await res.json() : { error: res.status };
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(body, null, 2));
  console.log(`${name}: ${res.status}`);
  return res.ok ? body : null;
}

const stripeRes = await fetch("https://cursor.com/api/auth/stripe", { headers });
const stripe = await save("stripe", stripeRes) as Record<string, unknown> | null;

await save("usage-legacy", await fetch(`https://cursor.com/api/usage?user=${userId}`, { headers }));
await save("usage-summary", await fetch("https://cursor.com/api/usage-summary", { headers }));

if (stripe?.teamId) {
  await save(
    "team-spend",
    await fetch("https://cursor.com/api/dashboard/get-team-spend", {
      method: "POST",
      headers,
      body: JSON.stringify({ teamId: stripe.teamId }),
    }),
  );
}

await save(
  "usage-events-page1",
  await fetch("https://cursor.com/api/dashboard/get-filtered-usage-events", {
    method: "POST",
    headers,
    body: JSON.stringify({
      teamId: stripe?.teamId ?? 0,
      startDate: String(Date.now() - 7 * 86400000),
      endDate: String(Date.now()),
      page: 1,
      pageSize: 3,
    }),
  }),
);

if (stripe?.teamId) {
  const periodEndMs = Date.now();
  const periodStartMs = periodEndMs - 31 * 86_400_000;
  await save(
    "daily-spend",
    await fetch("https://cursor.com/api/dashboard/get-daily-spend-by-category", {
      method: "POST",
      headers,
      body: JSON.stringify({
        teamId: stripe.teamId,
        userId: Number(userId),
        periodStartMs,
        periodEndMs,
        groupBy: 1,
        spendType: 1,
      }),
    }),
  );
}

console.log(`Fixtures written to ${outDir}`);
