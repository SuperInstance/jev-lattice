/**
 * Trusted fact extractors: code computes, Jev judges (R6).
 *
 * On hard cases (unit conversions, overridden directives, defaults) Jev was right but often
 * undecided; putting code-computed values next to the file took the hard bench from 179/200 to
 * 198/200 decided-correct (Brier 0.0189 → 0.0011). Jev also follows these values over the file
 * (a deliberately wrong fact flipped 9/60 verdicts), so extractors are plain, tested code —
 * never model-written — and they say "not set" rather than guess.
 *
 * A fact spec: { name, extract, ...args }. Extractors:
 *   directive  key            last uncommented `key value` line (case-insensitive key), e.g. redis.conf
 *   size       key            directive value → bytes (Redis units: 1k=1000, 1kb=1024, 1m, 1mb, 1g, 1gb)
 *   duration   key            `key: 30s` / `key 500ms` → milliseconds (ms, s, m, h)
 *   env        key            KEY=value from an env file (last wins, quotes stripped)
 *   json       path           dotted path in a JSON file (a.b.0.c)
 *   count      pattern        number of lines matching a regex (flags: i)
 *   regex      pattern        first capture group of the last match
 * Missing values become null ("not set"); `default` substitutes a documented default.
 */
const SIZE = { "": 1, k: 1000, kb: 1024, m: 1000 ** 2, mb: 1024 ** 2, g: 1000 ** 3, gb: 1024 ** 3 };
const DUR = { ms: 1, s: 1000, m: 60000, h: 3600000 };

function lastDirective(text, key) {
  let v = null;
  const k = key.toLowerCase();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([^\s:=]+)\s*[:=]?\s*(.*)$/);
    // strip an inline comment and an nginx-style terminating ";" (found by the MiniMax-M3 review)
    if (m && m[1].toLowerCase() === k) v = m[2].replace(/\s+#.*$/, "").trim().replace(/;$/, "").trim().replace(/^["']|["']$/g, "");
  }
  return v;
}

export function parseSize(v) {
  const m = String(v).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(k|kb|m|mb|g|gb)?$/);
  return m ? Math.round(Number(m[1]) * SIZE[m[2] || ""]) : null;
}
export function parseDuration(v) {
  const m = String(v).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/);
  return m ? Number(m[1]) * DUR[m[2]] : null;
}

export const EXTRACTORS = {
  directive: (text, { key }) => lastDirective(text, key),
  size: (text, { key }) => { const v = lastDirective(text, key); return v === null ? null : parseSize(v); },
  duration: (text, { key }) => { const v = lastDirective(text, key); return v === null ? null : parseDuration(v); },
  env: (text, { key }) => {
    let v = null;
    for (const line of String(text).split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && m[1] === key) v = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return v;
  },
  json: (text, { path }) => {
    let v;
    try { v = JSON.parse(text); } catch { return null; }
    for (const part of String(path).split(".")) { if (v === null || typeof v !== "object" || !(part in v)) return null; v = v[part]; }
    return v;
  },
  count: (text, { pattern, flags = "" }) => String(text).split(/\r?\n/).filter(l => new RegExp(pattern, flags.replace(/g/g, "")).test(l)).length,
  regex: (text, { pattern, flags = "" }) => {
    const all = [...String(text).matchAll(new RegExp(pattern, flags.includes("g") ? flags : flags + "g"))];
    return all.length ? all[all.length - 1][1] ?? all[all.length - 1][0] : null;
  }
};

/** Validate fact specs; → list of errors (empty = ok). */
export function checkFactSpecs(specs, where = "facts") {
  const errors = [];
  if (!Array.isArray(specs)) return [`${where}: must be an array`];
  specs.forEach((f, i) => {
    const at = `${where}[${i}]`;
    if (!f || typeof f.name !== "string" || !/^[A-Za-z_][\w.-]*$/.test(f.name)) errors.push(`${at}.name: identifier required`);
    if (!EXTRACTORS[f?.extract]) errors.push(`${at}.extract: one of ${Object.keys(EXTRACTORS).join(", ")}`);
    if (["directive", "size", "duration", "env"].includes(f?.extract) && typeof f.key !== "string") errors.push(`${at}.key: required for ${f.extract}`);
    if (f?.extract === "json" && typeof f.path !== "string") errors.push(`${at}.path: required for json`);
    if (["count", "regex"].includes(f?.extract)) {
      if (typeof f.pattern !== "string") errors.push(`${at}.pattern: required for ${f.extract}`);
      else try { new RegExp(f.pattern); } catch (e) { errors.push(`${at}.pattern: ${e.message}`); }
    }
  });
  return errors;
}

/** Run fact specs over one file's text → { name: value } (null = not set, unless a default is given). */
export function extractFacts(text, specs) {
  const out = {};
  for (const f of specs) {
    let v = EXTRACTORS[f.extract](text, f);
    if ((v === null || v === undefined) && f.default !== undefined) v = f.default;
    out[f.name] = v === null || v === undefined ? "not set" : v;
  }
  return out;
}

/** files: {path: text}; specsByFile: {path: [spec]} → {path: {name: value}} for present files. */
export function factsForFiles(files, specsByFile = {}) {
  const out = {};
  for (const [path, specs] of Object.entries(specsByFile)) if (path in files) out[path] = extractFacts(files[path], specs);
  return out;
}
