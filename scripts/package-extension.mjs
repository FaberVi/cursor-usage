import { execSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const variant = process.argv[2] ?? "ovsx";

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

await mkdir(path.join(root, "build"), { recursive: true });
execSync("bun run build", { cwd: root, stdio: "inherit" });

if (variant === "vsm") {
  execSync("bun scripts/prepare-vsm-package.mjs", { cwd: root, stdio: "inherit" });
  execSync(`bun x @vscode/vsce package --out "../cursor-usage-auto-${version}.vsix"`, {
    cwd: path.join(root, "build", "vsm-package"),
    stdio: "inherit",
  });
  console.log(`Packaged: build/cursor-usage-auto-${version}.vsix`);
} else {
  execSync(`bun x @vscode/vsce package --out "build/cursor-usage-${version}.vsix"`, {
    cwd: root,
    stdio: "inherit",
  });
  console.log(`Packaged: build/cursor-usage-${version}.vsix`);
}
