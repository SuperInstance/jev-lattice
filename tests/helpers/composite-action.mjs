/**
 * A tiny indentation-driven reader for a composite `action.yml` -- enough to pull out the
 * steps (name / id / if / run) so tests can assert on what the action actually says.
 * Deliberately not a general YAML parser: it only has to read the shape this repo ships.
 *
 *   runs:            indent 0
 *     steps:         indent 2
 *       - name: ...  indent 4   (a step)
 *         key: val   indent 6
 *           run body indent 8
 */
export function parseCompositeAction(text) {
  const lines = text.split("\n");
  const indentOf = (l) => l.length - l.trimStart().length;

  const runsIdx = lines.findIndex((l) => /^runs:\s*$/.test(l));
  if (runsIdx < 0) throw new Error("no runs: block found");
  const stepsIdx = lines.findIndex((l, i) => i > runsIdx && /^ {2}steps:\s*$/.test(l));
  if (stepsIdx < 0) throw new Error("no steps: block found");

  const steps = [];
  let cur = null;
  let capturing = false; // are we inside a `run: |` block scalar?

  for (let i = stepsIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ind = indentOf(line);
    if (ind <= 2) break; // end of the steps: block

    if (ind === 4 && line.trimStart().startsWith("- ")) {
      cur = { name: null, id: null, if: null, run: null };
      steps.push(cur);
      capturing = false;
      const kv = line.trimStart().slice(2).match(/^([\w-]+):\s*(.*)$/);
      if (kv && kv[1] === "name") cur.name = kv[2];
      continue;
    }
    if (!cur) continue;

    const body = line.trimStart();
    if (ind === 6) {
      const kv = body.match(/^([\w-]+):\s*(.*)$/);
      if (!kv) { capturing = false; continue; }
      const [, key, value] = kv;
      if (key === "run" && (value === "|" || value === "|-" || value === ">")) {
        capturing = true;
        cur.run = "";
      } else {
        capturing = false;
        if (key === "if") cur.if = value;
        else if (key === "id") cur.id = value;
        else if (key === "name") cur.name = value;
      }
      continue;
    }
    if (capturing && ind > 6) {
      cur.run += line.slice(8) + "\n";
    }
  }
  return steps;
}

export function findStep(steps, name) {
  const s = steps.find((x) => x.name === name);
  if (!s) throw new Error(`step not found: ${name}`);
  return s;
}
