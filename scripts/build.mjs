// Builds the extension into dist/ (load it unpacked from chrome://extensions):
//   1. the popup page and the background service worker (ES module);
//   2. each content script as a self-contained IIFE (content scripts can't be ES modules);
//   3. manifest.json, with the version of package.json (the CardLedger URL is set by the user in the popup).
// `--production` (used by `npm run package`): the manifest gets no localhost / 127.0.0.1 host permissions.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { manifest } from "./manifest.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = `${root}src`;
const outDir = `${root}dist`;
const production = process.argv.includes("--production");

await build({
  root: src,
  base: "",
  configFile: false,
  logLevel: "warn",
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2022",
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: `${src}/popup/index.html`,
        background: `${src}/background.ts`,
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});

const contentScripts = {
  "content-cardledger": `${src}/content/cardledger.ts`,
  "cardmarket-agent": `${src}/markets/cardmarket/agent.ts`,
  "cardtrader-agent": `${src}/markets/cardtrader/agent.ts`,
};
for (const [name, entry] of Object.entries(contentScripts)) {
  await build({
    configFile: false,
    logLevel: "warn",
      build: {
      outDir,
      emptyOutDir: false,
      target: "es2022",
      lib: { entry, name: name.replace(/-/g, "_"), formats: ["iife"], fileName: () => `${name}.js` },
    },
  });
}

const pkg = JSON.parse(await readFile(`${root}package.json`, "utf8"));
await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest(pkg.version, { production }), null, 2));
console.log(`Built CardLedger extension ${pkg.version}${production ? " (production)" : ""} into dist/`);
