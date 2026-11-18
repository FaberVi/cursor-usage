import { build, context } from "esbuild";

const isWatch = process.argv.includes("--watch");
const isProd = process.argv.includes("--production");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts", "src/db-worker.ts"],
  bundle: true,
  outdir: "dist",
  external: ["vscode", "sql.js"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !isProd,
  minify: isProd,
};

/** @type {import('esbuild').BuildOptions} */
const dashboardConfig = {
  entryPoints: ["media/dashboard/modules/entry.js"],
  bundle: true,
  outfile: "media/dashboard/dashboard.js",
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: isProd,
  loader: { ".ts": "ts" },
};

async function buildAll() {
  await build(extensionConfig);
  await build(dashboardConfig);
  console.log("Build complete.");
}

if (isWatch) {
  const extCtx = await context(extensionConfig);
  const dashCtx = await context(dashboardConfig);
  await extCtx.watch();
  await dashCtx.watch();
  console.log("Watching for changes...");
} else {
  await buildAll();
}
