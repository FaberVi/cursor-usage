/**
 * One-off probe: read local auth and fetch Cursor API responses for fixture discovery.
 *
 * After migrating to The X Subscription, save redacted output from stripe, usage-summary,
 * and get-sand-usage-status to update test/fixtures and membership slugs in plan-labels.ts.
 */
import { readCursorAuthValuesFromDb } from "../src/cursor-api";
import { openCursorAuthSecret } from "../src/cursor-safe-storage";
import { join } from "path";
import { homedir } from "os";

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

function redact(obj: unknown, depth = 0): unknown {
  if (depth > 6 || obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.slice(0, 3).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (/token|secret|password|jwt|cookie/i.test(k)) {
      out[k] = "[redacted]";
    } else if (typeof v === "string" && v.length > 120) {
      out[k] = v.slice(0, 40) + "…";
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

const authValues = readCursorAuthValuesFromDb(dbPath);
const rawToken = authValues["cursorAuth/accessToken"];
const email = authValues["cursorAuth/cachedEmail"] ?? null;
if (!rawToken) {
  console.error("No accessToken in database");
  process.exit(1);
}
let accessToken: string;
try {
  accessToken = await openCursorAuthSecret(rawToken);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not decrypt sealed token");
  process.exit(1);
}

const payload = decodeJwtPayload(accessToken);
const sub = typeof payload.sub === "string" ? payload.sub : "";
const userId = sub.split("|")[1] ?? sub;
const sessionToken = `${userId}%3A%3A${accessToken}`;

const headers = {
  "Content-Type": "application/json",
  Cookie: `WorkosCursorSessionToken=${sessionToken}`,
  Origin: "https://cursor.com",
  Referer: "https://cursor.com/dashboard",
};

console.log("=== Auth ===");
console.log(JSON.stringify({ userId, email, jwtSub: sub }, null, 2));

const stripeRes = await fetch("https://cursor.com/api/auth/stripe", { headers });
const stripe = stripeRes.ok ? await stripeRes.json() : { error: stripeRes.status };
console.log("\n=== /api/auth/stripe ===");
console.log(JSON.stringify(redact(stripe), null, 2));

const summaryRes = await fetch("https://cursor.com/api/usage-summary", { headers });
const summary = summaryRes.ok ? await summaryRes.json() : { error: summaryRes.status };
console.log("\n=== /api/usage-summary ===");
console.log(JSON.stringify(redact(summary), null, 2));

const sandRes = await fetch("https://cursor.com/api/dashboard/get-sand-usage-status", {
  method: "POST",
  headers,
  body: "{}",
});
const sand = sandRes.ok ? await sandRes.json() : { error: sandRes.status };
console.log("\n=== /api/dashboard/get-sand-usage-status ===");
console.log(JSON.stringify(redact(sand), null, 2));

const usageRes = await fetch(`https://cursor.com/api/usage?user=${userId}`, { headers });
const usage = usageRes.ok ? await usageRes.json() : { error: usageRes.status };
console.log("\n=== /api/usage ===");
console.log(JSON.stringify(redact(usage), null, 2));

if (stripe?.isTeamMember && stripe?.teamId) {
  const teamRes = await fetch("https://cursor.com/api/dashboard/get-team-spend", {
    method: "POST",
    headers,
    body: JSON.stringify({ teamId: stripe.teamId }),
  });
  const team = teamRes.ok ? await teamRes.json() : { error: teamRes.status };
  console.log("\n=== /api/dashboard/get-team-spend (top-level keys) ===");
  console.log(JSON.stringify(Object.keys(team as object), null, 2));

  const rawMembers = (team as { teamMemberSpend?: unknown[] }).teamMemberSpend ?? [];
  const members = rawMembers.filter(
    (member): member is Record<string, unknown> => typeof member === "object" && member !== null,
  );
  const me = members.find(
    (m) => m.email === email || String(m.userId) === String(userId),
  );
  console.log("\n=== teamMemberSpend member match ===");
  if (me) {
    console.log("keys:", Object.keys(me).join(", "));
    console.log(JSON.stringify(redact(me), null, 2));
  } else {
    console.log("No member match for email=", email, "userId=", userId);
    if (members[0]) {
      console.log("First member keys:", Object.keys(members[0]).join(", "));
      console.log(JSON.stringify(redact(members[0]), null, 2));
    }
  }
}

const eventsRes = await fetch("https://cursor.com/api/dashboard/get-filtered-usage-events", {
  method: "POST",
  headers,
  body: JSON.stringify({
    teamId: stripe?.teamId ?? 0,
    startDate: String(Date.now() - 7 * 86400000),
    endDate: String(Date.now()),
    page: 1,
    pageSize: 3,
  }),
});
const events = eventsRes.ok ? await eventsRes.json() : { error: eventsRes.status };
console.log("\n=== usage events sample ===");
const sample = (events as { usageEventsDisplay?: unknown[] }).usageEventsDisplay?.[0];
if (sample) {
  console.log("event keys:", Object.keys(sample as object).join(", "));
  console.log(JSON.stringify(redact(sample), null, 2));
} else {
  console.log(JSON.stringify(redact(events), null, 2));
}
