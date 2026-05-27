import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.mjs",
  external: ["vscode"],
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
};

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ["src/webview/webview-main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: false,
};

if (watch) {
  const [extCtx, webviewCtx] = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(webviewOptions),
  ]);
  await Promise.all([extCtx.watch(), webviewCtx.watch()]);
  console.log("Watching for changes...");
} else {
  await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(webviewOptions),
  ]);
  console.log("Build complete.");
}
