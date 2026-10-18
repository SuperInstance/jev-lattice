// Hand-written declarations must not drift from the runtime: every name a .d.ts exports
// as a value (function / const / class) exists in the module the package maps it to.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));
for (const [sub, target] of Object.entries(pkg.exports)) {
  if (typeof target !== "object" || !target.types) continue;
  test(`types match runtime: jev-lattice${sub === "." ? "" : sub.slice(1)}`, async () => {
    const dts = fs.readFileSync(new URL(`../${target.types}`, import.meta.url), "utf8");
    const declared = [...dts.matchAll(/^export (?:function|const|class) (\w+)/gm)].map(m => m[1]);
    const mod = await import(new URL(`../${target.default}`, import.meta.url));
    const missing = declared.filter(n => !(n in mod));
    assert.deepEqual(missing, [], `declared but not exported: ${missing.join(", ")}`);
    assert.ok(declared.length > 0);
  });
}
