import { configure, extractUsageFromSummary, fetchUsageData } from "../src/cursor-api";

configure({ logger: (msg) => console.log(msg) });

console.log("=== fetchUsageData ===");
const data = await fetchUsageData();
console.log(JSON.stringify(data, null, 2));

console.log("\n=== direct usage-summary parse ===");
import { readCursorAuthValuesFromDb } from "../src/cursor-api";
import { openCursorAuthSecret } from "../src/cursor-safe-storage";
import { join } from "path";
import { homedir } from "os";

const dbPath = join(
  process.env.APPDATA ?? join(homedir(), "AppData/Roaming"),
  "Cursor/User/globalStorage/state.vscdb",
);
const rawToken = readCursorAuthValuesFromDb(dbPath)["cursorAuth/accessToken"];
if (!rawToken) throw new Error("no jwt");
const jwt = await openCursorAuthSecret(rawToken);
const part = jwt.split(".")[1]!;
const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
const sub = JSON.parse(Buffer.from(padded, "base64").toString()).sub as string;
const userId = sub.split("|")[1]!;
const headers = {
  "Content-Type": "application/json",
  Cookie: `WorkosCursorSessionToken=${userId}%3A%3A${jwt}`,
  Origin: "https://cursor.com",
  Referer: "https://cursor.com/dashboard",
};

const res = await fetch("https://cursor.com/api/usage-summary", { headers });
console.log("status:", res.status);
const summary = res.ok ? await res.json() : await res.text();
console.log("raw:", typeof summary === "string" ? summary.slice(0, 200) : JSON.stringify(summary).slice(0, 500));
if (res.ok) {
  console.log("parsed:", JSON.stringify(extractUsageFromSummary(summary, true), null, 2));
}
