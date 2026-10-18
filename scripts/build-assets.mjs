// Copies the browser UI + shared core into worker/public for Workers Static Assets.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "worker", "public");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "browser"), { recursive: true });
for (const f of fs.readdirSync(path.join(root, "browser"))) {
  fs.copyFileSync(path.join(root, "browser", f), path.join(out, "browser", f));
}
fs.copyFileSync(path.join(root, "jev-core.js"), path.join(out, "jev-core.js"));
console.log("assets →", path.relative(root, out));
