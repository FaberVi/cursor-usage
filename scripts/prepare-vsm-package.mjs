import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const stageDir = path.join(rootDir, "build", "vsm-package");

const packageJson = JSON.parse(
  await readFile(path.join(rootDir, "package.json"), "utf8"),
);

const vsmPackageJson = {
  ...packageJson,
  name: "cursor-usage-auto",
};

const filesToCopy = [
  ".vscodeignore",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "icon.png",
  "bunfig.toml",
];

const directoriesToCopy = ["dist", "media"];

await rm(stageDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });

for (const file of filesToCopy) {
  await copyFile(path.join(rootDir, file), path.join(stageDir, file));
}

for (const directory of directoriesToCopy) {
  await cp(path.join(rootDir, directory), path.join(stageDir, directory), {
    recursive: true,
  });
}

await writeFile(
  path.join(stageDir, "package.json"),
  `${JSON.stringify(vsmPackageJson, null, 2)}\n`,
);
