/**
 * Seeded redis.conf generator with code-computed ground truth.
 * Traps: commented-out directives and later directives overriding earlier ones.
 */
export function makeGenerator(seed = 7) {
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = a => a[Math.floor(rnd() * a.length)];
  return function genConfig() {
  const c = {
    port: pick([0, 6379, 6380, 7000]),
    tls: rnd() < 0.5,
    maxmemoryMb: pick([null, 256, 1024, 4096]),
    policy: pick(["noeviction", "allkeys-lru", "volatile-lru", "allkeys-lfu"]),
    aof: rnd() < 0.5,
    aofCommentedTrap: rnd() < 0.3,
    pass: rnd() < 0.6,
    bind: pick(["127.0.0.1", "0.0.0.0", "10.0.0.5"]),
    overridePort: rnd() < 0.25 ? pick([6379, 6390]) : null
  };
  const lines = [`bind ${c.bind}`, `port ${c.port}`];
  if (c.tls) lines.push("tls-port 6380", "tls-cert-file /etc/redis/redis.crt");
  if (c.maxmemoryMb) lines.push(`maxmemory ${c.maxmemoryMb}mb`);
  lines.push(`maxmemory-policy ${c.policy}`);
  if (c.aofCommentedTrap && !c.aof) lines.push("# appendonly yes   (disabled during migration)");
  lines.push(`appendonly ${c.aof ? "yes" : "no"}`);
  if (c.pass) lines.push("requirepass s3cret");
  if (c.overridePort) { lines.push(`# override for staging`, `port ${c.overridePort}`); c.port = c.overridePort; }
  return { c, text: lines.join("\n") };
  };
}

export const QUESTIONS = [
  ["Is the plaintext (non-TLS) port disabled, i.e. is the effective `port` 0?", c => c.port === 0],
  ["Is TLS enabled (a tls-port is configured)?", c => c.tls],
  ["Is AOF persistence enabled (appendonly yes in effect)?", c => c.aof],
  ["Is a memory limit (maxmemory) configured?", c => c.maxmemoryMb !== null],
  ["Is the memory limit at least 1 GB?", c => (c.maxmemoryMb || 0) >= 1024],
  ["Does the eviction policy evict keys when memory is full (anything but noeviction)?", c => c.policy !== "noeviction"],
  ["Is password authentication (requirepass) configured?", c => c.pass],
  ["Is Redis bound only to the loopback interface?", c => c.bind === "127.0.0.1"],
  ["Is Redis listening on all interfaces (bind 0.0.0.0)?", c => c.bind === "0.0.0.0"],
  ["Is the effective plaintext port 6379?", c => c.port === 6379]
];


/** Reading rules that cover both the base and the shifted format. */
export const READING_RULES =
  "Directive names are case-insensitive; values may be quoted; separators may be spaces or tabs; " +
  "lines starting with # (after optional whitespace) are comments; later directives override earlier ones; " +
  "memory sizes use mb or gb units.";

/**
 * Distribution-shifted renderer: SAME semantics (ground truth computed from the
 * same fields), different surface form — uppercase directives, quoted values,
 * tabs, gb units, indented comments, and an overridden appendonly. Used to test
 * whether compiled predicates survive input drift.
 */
export function makeShiftedGenerator(seed = 7) {
  const base = makeGenerator(seed);
  let s2 = seed * 7919 + 1;
  const rnd = () => ((s2 = (s2 * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return function genShifted() {
    const { c } = base();
    const key = k => (rnd() < 0.5 ? k.toUpperCase() : k);
    const sep = () => (rnd() < 0.5 ? "\t" : "  ");
    const val = v => (rnd() < 0.4 ? `"${v}"` : String(v));
    const mem = mb => (mb >= 1024 && rnd() < 0.7 ? `${mb / 1024}gb` : `${mb}mb`);
    const line = (k, v) => `${key(k)}${sep()}${val(v)}`;
    const lines = [line("bind", c.bind), line("port", c.port)];
    if (c.tls) lines.push(line("tls-port", 6380), line("tls-cert-file", "/etc/redis/redis.crt"));
    if (c.maxmemoryMb) lines.push(`${key("maxmemory")}${sep()}${mem(c.maxmemoryMb)}`);
    lines.push(line("maxmemory-policy", c.policy));
    if (rnd() < 0.4) lines.push(line("appendonly", c.aof ? "no" : "yes"), "   # (overridden below)"); // later line wins
    if (c.aofCommentedTrap && !c.aof) lines.push(`    # ${key("appendonly")} yes`);
    lines.push(line("appendonly", c.aof ? "yes" : "no"));
    if (c.pass) lines.push(line("requirepass", "s3cret"));
    return { c, text: lines.join("\n"), shifted: true };
  };
}
