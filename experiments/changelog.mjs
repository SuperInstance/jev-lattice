#!/usr/bin/env node
/**
 * R3-B: CHANGELOG completeness — prose vs structured truth.
 *
 * State: a CHANGELOG.md with sections per release. Truth: the structured list of
 * PRs merged for the release (from the generator). Each PR is rendered as one of
 *   exact      "- Add retries to the uploader (#123)"
 *   paraphrase "- The uploader now retries failed requests"     (no PR number)
 *   missing    not listed
 *   wrong-rel  listed, but under the PREVIOUS release (trap)
 * Question per PR: "Does the v2.0.0 section mention <title> (PR #n)?"
 *
 * Verifiers:
 *   regex      code: "#n" appears inside the v2.0.0 section
 *   jev        Noul, all PRs of a release in ONE fan-out call
 *   hybrids    refute-only (regex NO final, YES → Jev)  vs  confirm-only (regex YES final, NO → Jev)
 * And: does a label bank, taught by Jev, discover which DIRECTION of the regex is trustworthy?
 *
 *   node experiments/changelog.mjs [--releases 25]
 */
import fs from "node:fs";
import { createJev } from "../providers/jev.mjs";

const args = process.argv.slice(2);
const N = args.includes("--releases") ? Number(args[args.indexOf("--releases") + 1]) : 25;

let seed = 4242;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = a => a[Math.floor(rnd() * a.length)];

// title template ↔ paraphrase template (deterministic paraphrases with the same meaning)
const CHANGES = [
  ["Add retries to the {c}", "The {c} now retries failed requests"],
  ["Fix crash in {c} on empty input", "{C} no longer crashes when given empty input"],
  ["Remove deprecated {c} flag", "The old {c} flag is gone"],
  ["Speed up {c} startup", "{C} starts faster"],
  ["Support dark mode in the {c}", "The {c} can now be used in dark mode"],
  ["Log {c} timeouts", "{C} timeouts are now written to the log"],
  ["Validate {c} config on load", "{C} configuration is checked when it is loaded"],
  ["Upgrade {c} dependency", "Bumped the library the {c} depends on"]
];
const COMPONENTS = ["uploader", "scheduler", "billing page", "CLI", "search index", "auth service", "export job", "dashboard"];
const cap = s => s[0].toUpperCase() + s.slice(1);

function genRelease(i) {
  const version = `v2.${i}.0`, prev = `v2.${i - 1 < 0 ? 0 : i - 1}.9`;
  let num = 1000 + i * 40;
  // (template, component) pairs are unique per release: two PRs with the same change
  // would make "is this change mentioned?" ambiguous (found by auditing Jev's only 2 "wrong GOs")
  const used = new Set();
  const prs = Array.from({ length: 6 + Math.floor(rnd() * 5) }, () => {
    let t, p, c;
    do { [t, p] = pick(CHANGES); c = pick(COMPONENTS); } while (used.has(t + c));
    used.add(t + c);
    const r = rnd();
    const render = r < 0.35 ? "exact" : r < 0.65 ? "paraphrase" : r < 0.85 ? "missing" : "wrong-rel";
    return { n: num++, title: t.replace("{c}", c), para: p.replace("{c}", c).replace("{C}", cap(c)), render };
  });
  const cur = [], old = [];
  for (const pr of prs) {
    if (pr.render === "exact") cur.push(`- ${pr.title} (#${pr.n})`);
    if (pr.render === "paraphrase") cur.push(`- ${pr.para}`);
    if (pr.render === "wrong-rel") old.push(`- ${pr.title} (#${pr.n})`);
  }
  // unrelated filler entries so sections aren't trivially small
  cur.push(`- Documentation tweaks`);
  old.push(`- Initial ${pick(COMPONENTS)} release notes`, `- Fix typo in README (#${num + 7})`);
  const changelog = `# Changelog\n\n## ${version}\n\n${cur.sort(() => rnd() - 0.5).join("\n")}\n\n## ${prev}\n\n${old.join("\n")}\n`;
  return { version, prs, changelog };
}

function regexYes(changelog, version, n) {
  const sec = changelog.split(/^## /m).find(s => s.startsWith(version)) || "";
  return new RegExp(`#${n}\\b`).test(sec);
}

const jev = createJev();
const rows = [];
await Promise.all(Array.from({ length: N }, (_, i) => genRelease(i + 1)).map(async rel => {
  const items = rel.prs.map(pr => ({
    key: `pr${pr.n}`,
    instructions: `Does the ${rel.version} section of the changelog mention this change: "${pr.title}" (PR #${pr.n})? A paraphrased entry without the PR number still counts; an entry under a different release does not.`
  }));
  // Choice framing (T24): which line of the release section describes this change, if any?
  const sec = (rel.changelog.split(/^## /m).find(x => x.startsWith(rel.version)) || "").split("\n").filter(l => l.startsWith("- "));
  const criteria = Object.fromEntries([...sec.map((l, i) => [`line${i + 1}`, l.slice(2)]), ["none", "No line in this release describes the change"]]);
  const questions = {};
  for (const it of items) questions[it.key] = { type: "noul", instructions: it.instructions };
  for (const pr of rel.prs) {
    questions[`c${pr.n}`] = { type: "choice", instructions: `Which line of the ${rel.version} release notes describes this change: "${pr.title}" (PR #${pr.n})?`, criteria };
  }
  const data = await jev.ask({ "CHANGELOG.md": rel.changelog }, questions);
  for (const pr of rel.prs) {
    const ch = data.answers[`c${pr.n}`];
    rows.push({
      pr, version: rel.version, changelog: rel.changelog, choice: ch,
      render: pr.render, truth: pr.render === "exact" || pr.render === "paraphrase", regex: regexYes(rel.changelog, rel.version, pr.n),
      p: data.answers[`pr${pr.n}`].noul,
      pChoice: Math.max(0, Math.min(1, 1 - (ch.probabilities?.none ?? 1))),
      // a specific match: the single most likely line (not the sum over similar lines)
      pMaxLine: Math.max(0, ...Object.entries(ch.probabilities || {}).filter(([k]) => k !== "none").map(([, v]) => v))
    });
  }
}));

const T = 0.9;
const verdict = p => (p >= T ? "GO" : p <= 1 - T ? "REFUTED" : "OPEN");
function score(name, f) {
  let correct = 0, wrongGo = 0, wrongRef = 0, open = 0, jevQ = 0;
  for (const r of rows) {
    const { v, usedJev } = f(r);
    if (usedJev) jevQ++;
    if (v === "OPEN") open++;
    else if ((v === "GO") === r.truth) correct++;
    else if (v === "GO") wrongGo++;
    else wrongRef++;
  }
  return { name, n: rows.length, correct, wrongGo, wrongRef, open, jevQ };
}
const results = [
  score("regex", r => ({ v: r.regex ? "GO" : "REFUTED", usedJev: false })),
  score("jev", r => ({ v: verdict(r.p), usedJev: true })),
  score("refute-only (regex NO final)", r => (r.regex ? { v: verdict(r.p), usedJev: true } : { v: "REFUTED", usedJev: false })),
  score("confirm-only (regex YES final)", r => (r.regex ? { v: "GO", usedJev: false } : { v: verdict(r.p), usedJev: true })),
  score("jev choice (P(not none))", r => ({ v: verdict(r.pChoice), usedJev: true })),
  score("confirm-only + choice", r => (r.regex ? { v: "GO", usedJev: false } : { v: verdict(r.pChoice), usedJev: true })),
  score("jev choice (max line)", r => ({ v: verdict(r.pMaxLine), usedJev: true })),
  // lattice combination: two proofs on one BINARY gate — any ≥T and none ≤1-T → GO; both → CONFLICT (blocks)
  score("lattice: choice-sum + noul veto", r => ({ v: combine([r.pChoice, r.p]), usedJev: true })),
  score("lattice: max-line + noul veto", r => ({ v: combine([r.pMaxLine, r.p]), usedJev: true })),
  score("confirm-only + max-line + veto", r => (r.regex ? { v: "GO", usedJev: false } : { v: combine([r.pMaxLine, r.p]), usedJev: true }))
];
function combine(ps) {
  const yes = ps.some(p => p >= T), no = ps.some(p => p <= 1 - T);
  return yes && no ? "OPEN" /* CONFLICT: not a GO, not a decided NO */ : yes ? "GO" : no ? "REFUTED" : "OPEN";
}
console.log(`${N} releases, ${rows.length} PR questions (exact ${rows.filter(r => r.render === "exact").length}, paraphrase ${rows.filter(r => r.render === "paraphrase").length}, missing ${rows.filter(r => r.render === "missing").length}, wrong-release ${rows.filter(r => r.render === "wrong-rel").length})\n`);
console.log("strategy                         correct  wrongGO  wrongREF  open  jevQuestions");
for (const r of results) console.log(`${r.name.padEnd(32)} ${String(r.correct).padStart(7)}  ${String(r.wrongGo).padStart(7)}  ${String(r.wrongRef).padStart(8)}  ${String(r.open).padStart(4)}  ${String(r.jevQ).padStart(12)}`);

if (args.includes("--dump-wrong")) {
  for (const r of rows.filter(r => !r.truth && (r.pChoice >= T || r.pMaxLine >= T))) {
    console.log(`\nWRONG GO candidate: PR #${r.pr.n} "${r.pr.title}" render=${r.render} noul=${r.p} choice=${JSON.stringify(r.choice.probabilities)}`);
    console.log(r.changelog);
  }
}
console.log("\nper rendering (jev verdict / regex):");
for (const kind of ["exact", "paraphrase", "missing", "wrong-rel"]) {
  const k = rows.filter(r => r.render === kind);
  const jv = k.map(r => verdict(r.p));
  const cv = k.map(r => verdict(r.pChoice));
  console.log(`  ${kind.padEnd(10)} n=${String(k.length).padStart(3)}  noul GO ${jv.filter(v => v === "GO").length} OPEN ${jv.filter(v => v === "OPEN").length} REF ${jv.filter(v => v === "REFUTED").length}   choice GO ${cv.filter(v => v === "GO").length} OPEN ${cv.filter(v => v === "OPEN").length} REF ${cv.filter(v => v === "REFUTED").length}   regex yes ${k.filter(r => r.regex).length}`);
}

// Trust direction learned from a Jev-taught bank (no ground truth): precision of each regex direction
const decided = rows.filter(r => verdict(r.p) !== "OPEN").map(r => ({ ...r, teacher: verdict(r.p) === "GO" }));
const dir = sayYes => {
  const d = decided.filter(r => r.regex === sayYes);
  const agree = d.filter(r => r.teacher === sayYes).length;
  return { n: d.length, precision: d.length ? +(agree / d.length).toFixed(3) : null };
};
const learned = { regexSaysYes: dir(true), regexSaysNo: dir(false) };
const truthDir = sayYes => {
  const d = rows.filter(r => r.regex === sayYes);
  return d.length ? +(d.filter(r => r.truth === sayYes).length / d.length).toFixed(3) : null;
};
console.log(`\ntrust direction learned from Jev labels: YES precision ${learned.regexSaysYes.precision} (n=${learned.regexSaysYes.n}), NO precision ${learned.regexSaysNo.precision} (n=${learned.regexSaysNo.n})`);
console.log(`trust direction from ground truth:        YES precision ${truthDir(true)}, NO precision ${truthDir(false)}`);
console.log(`→ policy the bank would pick: ${learned.regexSaysYes.precision >= 0.99 && learned.regexSaysNo.precision < 0.99 ? "confirm-only" : learned.regexSaysNo.precision >= 0.99 && learned.regexSaysYes.precision < 0.99 ? "refute-only" : learned.regexSaysYes.precision >= 0.99 ? "trust both" : "trust neither"}`);
console.log(`\njev usage ${JSON.stringify(jev.usage)}`);
if (args.includes("--out")) fs.writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify({ at: new Date().toISOString(), N, results, learned, truth: { yes: truthDir(true), no: truthDir(false) } }, null, 2));
