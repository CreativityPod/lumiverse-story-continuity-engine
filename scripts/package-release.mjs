import { mkdir, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const archive = join(root, "release", `Story_Continuity_Engine_v${pkg.version}.zip`);
const entries = ["spindle.json", "package.json", "package-lock.json", "README.md", "ARCHITECTURE.md", ".gitignore"];
async function collect(directory) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(path); else entries.push(path);
  }
}
for (const directory of ["src", "dist", "scripts", "test"]) await collect(directory);
await mkdir(join(root, "release"), { recursive: true });
const prefix = "lumiverse-story-continuity-engine/";
execFileSync("zip", ["-q", "-FS", archive, ...entries.map(path => `${prefix}${path}`)], { cwd: dirname(root.replace(/\/$/, "")) });
const listing = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" });
for (const path of ["spindle.json", "dist/backend.js", "dist/frontend.js"]) if (!listing.split("\n").includes(`${prefix}${path}`)) throw new Error(`Archive missing ${path}`);
if (listing.includes("node_modules/")) throw new Error("Archive must not contain development dependencies");
console.log(`Release archive created: ${archive}`);
