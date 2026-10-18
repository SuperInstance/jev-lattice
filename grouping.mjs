/**
 * Choice-first grouping (tiles T24, T40): ask about a field once, derive the yes/no answers.
 *
 * Several Noul questions often read one underlying setting ("Is LOG_LEVEL debug?",
 * "Is LOG_LEVEL info or warn?"). One Choice about the setting, with each question mapped
 * to the options that mean "yes", is cheaper and, in R4-B, better calibrated
 * (Brier 0.0001 vs 0.0056, recall@0.9 1.000 vs 0.965).
 *
 *   proposeGroups    a model proposes groups + mappings (it may also propose nothing)
 *   validateGroups   accept a mapping only if it never confidently disagrees with Jev's own
 *                    Noul on sample states, and agrees confidently often enough
 *   createGroupedAsker  answer a question set with accepted Choices + remaining Nouls
 *   groupCandidates  auto-trigger: ≥ minShared questions reading the same file
 *
 * Experimental API (jev-lattice/experimental/grouping).
 */
const CONFIDENT = p => p >= 0.95 || p <= 0.05;

/** Questions worth trying to group: buckets of ≥ minShared questions that read the same file. */
export function groupCandidates(questions, { minShared = 3 } = {}) {
  const byFile = new Map();
  for (const q of questions) for (const f of q.reads || []) (byFile.get(f) || byFile.set(f, []).get(f)).push(q);
  return [...byFile.entries()].filter(([, qs]) => qs.length >= minShared).map(([file, qs]) => ({ file, questions: qs }));
}

/**
 * @param {{key:string, text:string}[]} questions
 * → [{ choice: {instructions, criteria}, derived: [{key, allowed[]}] }]
 */
export async function proposeGroups({ mm, questions, context = "a configuration file" }) {
  const prompt = `These yes/no questions are asked about ${context}:
${questions.map(q => `${q.key}: ${q.text}`).join("\n")}

Group questions that are answered by ONE underlying setting into a single multiple-choice question about that setting. For each group give: "choice": {"instructions": "<question about the setting>", "criteria": {"<option>": "<description>", ...}} with mutually exclusive, exhaustive options (include a "not set" option where relevant), and "derived": [{"key": "<question key>", "allowed": ["<options that mean yes>"]}]. Only group questions about the same setting. Questions that need more than one setting, or are alone on their setting, stay ungrouped. It is fine to return no groups.
Reply with JSON {"groups": [...]}.`;
  const { value } = await mm.json(prompt, { maxTokens: 8000, temperature: 0.2 });
  const keys = new Set(questions.map(q => q.key));
  return (value?.groups || [])
    .filter(g => g?.choice?.instructions && g.choice.criteria && typeof g.choice.criteria === "object" && Array.isArray(g.derived))
    .map(g => ({
      choice: { instructions: String(g.choice.instructions), criteria: Object.fromEntries(Object.entries(g.choice.criteria).map(([k, v]) => [String(k), String(v)])) },
      derived: g.derived
        .map(d => ({ key: String(d.key ?? d.q), allowed: (d.allowed || []).map(String).filter(o => o in g.choice.criteria) }))
        .filter(d => keys.has(d.key) && d.allowed.length)
    }))
    .filter(g => g.derived.length);
}

/** One Jev call answering every Noul and every Choice; derived["group:key"] = Σ P(allowed options). */
async function askAll(jev, state, questions, groups) {
  const qs = {};
  for (const q of questions) qs[q.key] = { type: "noul", instructions: q.text };
  groups.forEach((g, i) => { qs[`__g${i}`] = { type: "choice", instructions: g.choice.instructions, criteria: g.choice.criteria }; });
  const d = await jev.ask(state, qs);
  const derived = {};
  groups.forEach((g, i) => {
    const probs = d.answers[`__g${i}`]?.probabilities || {};
    for (const m of g.derived) derived[`${i}:${m.key}`] = Math.min(1, m.allowed.reduce((s, o) => s + (Number(probs[o]) || 0), 0));
  });
  return { noul: Object.fromEntries(questions.map(q => [q.key, d.answers[q.key]?.noul])), derived };
}

/**
 * Validate mappings on sample states with Jev's Nouls as the teacher.
 * → { accepted: {key: {group, allowed}}, report: {key: {agree, disagree, ok}} }
 */
export async function validateGroups({ jev, questions, groups, states, minAgree = 10 }) {
  const answers = await Promise.all(states.map(s => askAll(jev, s, questions, groups)));
  const report = {}, accepted = {};
  groups.forEach((g, gi) => {
    for (const m of g.derived) {
      let agree = 0, disagree = 0;
      for (const a of answers) {
        const pn = a.noul[m.key], pd = a.derived[`${gi}:${m.key}`];
        if (typeof pn !== "number" || !CONFIDENT(pn) || !CONFIDENT(pd)) continue;
        if ((pn >= 0.5) === (pd >= 0.5)) agree++; else disagree++;
      }
      // a question mapped by two groups keeps the first that validates
      const ok = disagree === 0 && agree >= minAgree;
      report[m.key] = report[m.key]?.ok ? report[m.key] : { agree, disagree, ok };
      if (ok && !accepted[m.key]) accepted[m.key] = { group: gi, allowed: m.allowed };
    }
  });
  return { accepted, report };
}

/**
 * ask(state) → { p: {key: number}, source: {key: "choice"|"noul"}, questionsAsked }
 * Accepted questions are derived from their group's Choice; the rest are asked as Nouls.
 */
export function createGroupedAsker({ jev, questions, groups, accepted }) {
  const used = [...new Set(Object.values(accepted).map(a => a.group))];
  const nouls = questions.filter(q => !accepted[q.key]);
  return {
    questionsPerState: used.length + nouls.length,
    async ask(state) {
      const qs = {};
      for (const q of nouls) qs[q.key] = { type: "noul", instructions: q.text };
      for (const gi of used) qs[`__g${gi}`] = { type: "choice", instructions: groups[gi].choice.instructions, criteria: groups[gi].choice.criteria };
      const d = await jev.ask(state, qs);
      const p = {}, source = {}, answers = {};
      for (const q of nouls) { p[q.key] = d.answers[q.key]?.noul; source[q.key] = "noul"; }
      for (const [key, a] of Object.entries(accepted)) {
        const probs = d.answers[`__g${a.group}`]?.probabilities || {};
        p[key] = Math.min(1, a.allowed.reduce((s, o) => s + (Number(probs[o]) || 0), 0));
        source[key] = "choice";
        answers[key] = d.answers[`__g${a.group}`];
      }
      return { p, source, choices: answers, model: d.model, questionsAsked: Object.keys(qs).length };
    }
  };
}
