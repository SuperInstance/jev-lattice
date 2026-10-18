/**
 * Seeded multi-file "repo" generator: redis.conf + nginx.conf + app.env, each with
 * code-computed truth. Used to test per-file evidence channels (R3-C).
 */
import { makeGenerator, QUESTIONS as REDIS_Q } from "./redis-gen.mjs";

export function makeRepoGenerator(seed = 1) {
  const redis = makeGenerator(seed);
  let s = seed * 31 + 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = a => a[Math.floor(rnd() * a.length)];

  function nginx() {
    const c = { ssl: rnd() < 0.5, gzip: rnd() < 0.5, hsts: rnd() < 0.4, workers: pick([1, 2, 4, "auto"]) };
    const lines = [`worker_processes ${c.workers};`, "http {", `  gzip ${c.gzip ? "on" : "off"};`, "  server {"];
    lines.push(c.ssl ? "    listen 443 ssl;" : "    listen 80;");
    if (c.ssl) lines.push("    ssl_certificate /etc/ssl/site.crt;");
    if (c.hsts) lines.push('    add_header Strict-Transport-Security "max-age=31536000";');
    lines.push("  }", "}");
    return { c, text: lines.join("\n") };
  }
  function env() {
    const c = { debug: rnd() < 0.4, level: pick(["debug", "info", "warn"]), sentry: rnd() < 0.6 };
    const lines = [`DEBUG=${c.debug ? "true" : "false"}`, `LOG_LEVEL=${c.level}`];
    if (c.sentry) lines.push("SENTRY_DSN=https://abc@sentry.example/1");
    return { c, text: lines.join("\n") };
  }
  const gens = { "redis.conf": redis, "nginx.conf": nginx, "app.env": env };
  return {
    files: Object.keys(gens),
    gen: path => gens[path](),
    genRepo: () => Object.fromEntries(Object.keys(gens).map(p => [p, gens[p]()]))
  };
}

export const REPO_QUESTIONS = [
  ["redis.conf", REDIS_Q[1][0], c => REDIS_Q[1][1](c)],
  ["redis.conf", REDIS_Q[2][0], c => REDIS_Q[2][1](c)],
  ["redis.conf", REDIS_Q[6][0], c => REDIS_Q[6][1](c)],
  ["nginx.conf", "Does nginx serve HTTPS (listen 443 ssl)?", c => c.ssl],
  ["nginx.conf", "Is gzip compression enabled in nginx?", c => c.gzip],
  ["nginx.conf", "Does nginx send a Strict-Transport-Security header?", c => c.hsts],
  ["app.env", "Is DEBUG disabled in app.env?", c => !c.debug],
  ["app.env", "Is LOG_LEVEL set to info or warn (not debug)?", c => c.level !== "debug"],
  ["app.env", "Is error reporting configured (SENTRY_DSN set)?", c => c.sentry]
];

export const REPO_RULES = "Each file is independent. In redis.conf later directives override earlier ones and # lines are comments.";
