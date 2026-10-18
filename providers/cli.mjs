/** Shared CLI for chat providers: node providers/<p>.mjs [--model id] "prompt" [file …] (stdin if no prompt). */
export async function runCli(moduleUrl, create) {
  const argv = globalThis.process?.argv;
  if (!argv?.[1] || moduleUrl !== new URL(`file://${argv[1]}`).href) return;
  const { readFileSync } = await import("node:fs");
  const args = argv.slice(2);
  const mi = args.indexOf("--model");
  const model = mi >= 0 ? args.splice(mi, 2)[1] : undefined;
  let [prompt, ...files] = args;
  if (prompt === undefined) prompt = readFileSync(0, "utf8");
  for (const f of files) prompt += `\n\n----- FILE: ${f} -----\n${readFileSync(f, "utf8")}`;
  const p = create(model ? { model } : {});
  const out = await p.chat(prompt);
  process.stdout.write(out.text + "\n");
  process.stderr.write(`[${p.provider}] ${out.model} usage=${JSON.stringify(out.usage)}\n`);
}
