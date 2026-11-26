// Builds the extension for production and zips dist/ for the Chrome Web Store: cardledger-sync-<version>.zip.
// The default CardLedger URL is package.json's `cardledger.productionUrl`, or VITE_CARDLEDGER_URL to override it
// (e.g. staging); it must be https. The production build has no localhost host permissions. Needs the `zip` command.
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(`${root}package.json`, "utf8"));
const url = process.env.VITE_CARDLEDGER_URL || pkg.cardledger?.productionUrl;
if (!url || !URL.canParse(url) || new URL(url).protocol !== "https:") {
  console.error(`The production CardLedger URL must be https (got ${JSON.stringify(url ?? "")}).`);
  console.error("Set cardledger.productionUrl in package.json, or VITE_CARDLEDGER_URL=https://… npm run package");
  process.exit(1);
}

const zip = `${root}cardledger-sync-${pkg.version}.zip`;

execFileSync("npm", ["run", "build", "--", "--production"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VITE_CARDLEDGER_URL: url },
});
await rm(zip, { force: true }); // zip -r would update an existing archive, keeping stale files
execFileSync("zip", ["-r", "-q", zip, "."], { cwd: `${root}dist`, stdio: "inherit" });
console.log(`Packaged ${pkg.version} for ${url} into ${zip.slice(root.length)}`);
