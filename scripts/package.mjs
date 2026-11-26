// Builds the extension for production and zips dist/ for the Chrome Web Store: cardledger-sync-<version>.zip.
// The production build has no localhost host permissions and no CardLedger URL: the user sets it in the popup's
// Settings. Needs the `zip` command.
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(`${root}package.json`, "utf8"));
const zip = `${root}cardledger-sync-${pkg.version}.zip`;

execFileSync("npm", ["run", "build", "--", "--production"], { cwd: root, stdio: "inherit" });
await rm(zip, { force: true }); // zip -r would update an existing archive, keeping stale files
execFileSync("zip", ["-r", "-q", zip, "."], { cwd: `${root}dist`, stdio: "inherit" });
console.log(`Packaged ${pkg.version} into ${zip.slice(root.length)}`);
