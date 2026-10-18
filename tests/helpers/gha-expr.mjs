/**
 * A minimal, faithful implementation of the GitHub Actions expression semantics that
 * action.yml gates depend on.
 *
 * Source: docs.github.com/en/actions/reference/workflows-and-actions/expressions
 *   "GitHub performs loose equality comparisons. If the types do not match, GitHub coerces
 *    the type to a number. ... Null -> 0 | Boolean -> true:1 false:0 | String -> parsed from
 *    any legal JSON number format, otherwise NaN. Note: empty string returns 0."
 *   "GitHub ignores case when comparing strings."
 *   "in conditionals, falsy values (false, 0, -0, "", '', null) are coerced to false"
 *
 * The point of having it here is that a skipped step's outputs are *null*, and null coerces
 * to 0 -- which is why `steps.x.outputs.y != '0'` is FALSE for a step that never ran.
 */

export function toNumber(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    if (v.trim() === "") return 0;
    const n = Number(v);
    return Number.isNaN(n) ? NaN : n;
  }
  if (Array.isArray(v) || typeof v === "object") return NaN;
  return NaN;
}

export function looseEq(a, b) {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  if (typeof a === "number" && typeof b === "number") return a === b;
  const x = toNumber(a), y = toNumber(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  return x === y;
}

export function falsy(v) {
  return v === false || v === null || v === undefined || v === "" || v === 0 || v === -0;
}
const truthy = (v) => !falsy(v);

const TOKEN = /\|\||&&|==|!=|[!<>=]=?|[(),]|[A-Za-z_][\w.-]*(?:\.[\w.-]+)*|'[^']*'/g;

function parse(tokens, ctx) {
  let i = 0;
  const peek = () => tokens[i];
  const eat = (t) => { if (tokens[i] === t) { i++; return true; } return false; };

  function primary() {
    const t = tokens[i];
    if (t === undefined) throw new Error("unexpected end of expression");
    if (t === "(") { i++; const v = or(); eat(")"); return v; }
    if (t === "!") { i++; return !truthy(primary()); }
    if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
      i++;
      return t.slice(1, -1).replace(/''/g, "'"); // '' inside a literal is an escaped quote
    }
    if (/^[A-Za-z_]/.test(t)) {
      i++;
      let cur = ctx;
      for (const seg of t.split(".")) {
        if (cur === null || cur === undefined) return null; // unset context key -> null
        cur = cur[seg];
      }
      return cur === undefined ? null : cur;
    }
    i++;
    return null;
  }
  const unary = primary;
  function cmp() {
    let l = unary();
    while (peek() === "==" || peek() === "!=") {
      const op = tokens[i++];
      const r = unary();
      l = op === "==" ? looseEq(l, r) : !looseEq(l, r);
    }
    return l;
  }
  function and() { let l = cmp(); while (eat("&&")) { const r = cmp(); l = truthy(l) && truthy(r); } return l; }
  function or() { let l = and(); while (eat("||")) { const r = and(); l = truthy(l) || truthy(r); } return l; }
  return or();
}

/** Evaluate a GitHub Actions `if:` condition (with or without the ${{ }} wrapper). */
export function evalIf(expr, ctx) {
  const src = expr.trim().replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  return truthy(parse(src.match(TOKEN) || [], ctx));
}

/** Build the `steps` context for one simulated run. */
export function stepContext(steps) {
  const ctx = { steps: {} };
  for (const [id, s] of Object.entries(steps)) {
    const ran = s.outcome !== "skipped" && s.outcome !== "cancelled" && s.outcome !== undefined;
    ctx.steps[id] = { outcome: s.outcome, conclusion: s.outcome, outputs: ran ? s.outputs || {} : null };
  }
  return ctx;
}
