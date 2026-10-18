/**
 * Hard cases for verifiers, each with code-computed truth. Families target known weak spots:
 *   units      sizes in mixed units near a threshold (1000mb vs 1gb vs 1073741824)
 *   override   the same directive repeated, case-varied, some commented out
 *   count      "at least N" over a YAML list
 *   xref       a value defined in one file and referenced in another
 *   duration   timeouts in mixed units (ms, s, m) against a bound
 *   nested     JSON with the setting deep inside, plus a decoy at another path
 *   range      firewall rules where a port range covers (or just misses) a port
 *   default    the setting is absent and the question depends on the documented default
 * Each case: { family, files: {path: text}, question, truth, rules }.
 */
export function makeHardGenerator(seed = 1) {
  let s = seed * 7919 + 13;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  const fam = {
    units() {
      const bytes = pick([900, 1000, 1023, 1024, 1025, 1100, 2048]) * 1024 * 1024 * pick([1, 1, 1, 1024]) / pick([1, 1, 1, 1024]);
      const mb = bytes / 1048576;
      const fmt = pick([
        () => `${bytes}`, () => `${Math.round(mb)}mb`, () => `${Math.round(mb)}MB`,
        () => (mb % 1024 === 0 ? `${mb / 1024}gb` : `${Math.round(mb)}mb`), () => `${Math.round(bytes / 1024)}kb`
      ])();
      const real = /gb$/i.test(fmt) ? parseFloat(fmt) * 1073741824 : /mb$/i.test(fmt) ? parseFloat(fmt) * 1048576 : /kb$/i.test(fmt) ? parseFloat(fmt) * 1024 : Number(fmt);
      return { files: { "redis.conf": `port 6379\nmaxmemory ${fmt}\nmaxmemory-policy allkeys-lru` }, question: "Is the configured maxmemory at least 1 GiB (1073741824 bytes)?", truth: real >= 1073741824, rules: "Redis units: kb=1024, mb=1024², gb=1024³ bytes (case-insensitive); a bare number is bytes.", facts: { maxmemory_bytes: real } };
    },
    override() {
      const vals = Array.from({ length: int(2, 5) }, () => ({ v: pick(["yes", "no"]), comment: rnd() < 0.3, cas: pick(["appendonly", "APPENDONLY", "AppendOnly"]) }));
      const lines = vals.map(x => `${x.comment ? "# " : ""}${x.cas} ${x.v}`);
      const eff = vals.filter(x => !x.comment).pop();
      return { files: { "redis.conf": ["port 6379", ...lines].join("\n") }, question: "Is AOF persistence enabled (appendonly yes in effect)?", truth: eff ? eff.v === "yes" : false, rules: "Directives are case-insensitive; the last uncommented occurrence wins; # starts a comment; appendonly defaults to no.", facts: { effective_appendonly: eff ? eff.v : "no (default)" } };
    },
    count() {
      const n = int(0, 7), need = int(2, 5);
      const users = Array.from({ length: n + int(1, 4) }, (_, i) => ({ name: `user${i}`, role: i < n ? "admin" : pick(["viewer", "editor", "admins-readonly"]) }));
      users.sort(() => rnd() - 0.5);
      return { files: { "users.yaml": "users:\n" + users.map(u => `  - name: ${u.name}\n    role: ${u.role}`).join("\n") }, question: `Are there at least ${need} users whose role is exactly "admin"?`, truth: n >= need, rules: "YAML list of users; role must equal admin exactly.", facts: { admin_count: n } };
    },
    xref() {
      const tls = rnd() < 0.5, name = pick(["REDIS_TLS", "CACHE_TLS_ENABLED", "TLS_ON"]);
      const decoy = rnd() < 0.5;
      return {
        files: {
          "app.env": `${name}=${tls ? "true" : "false"}\n${decoy ? `${name}_LEGACY=${tls ? "false" : "true"}` : "LOG_LEVEL=info"}`,
          "docker-compose.yml": `services:\n  cache:\n    image: redis:7\n    environment:\n      TLS: \${${name}}\n`
        },
        question: "Is TLS turned on for the cache service once environment variables are substituted?", truth: tls, rules: "docker-compose substitutes ${VAR} from app.env; true/false are booleans.", facts: { cache_TLS_after_substitution: tls ? "true" : "false" }
      };
    },
    duration() {
      const ms = pick([500, 999, 1000, 1001, 2500, 30000, 59999, 60000, 61000]);
      const fmt = pick([() => `${ms}ms`, () => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`), () => (ms % 60000 === 0 ? `${ms / 60000}m` : `${ms / 1000}s`)])();
      const bound = pick([1000, 60000]);
      return { files: { "service.yaml": `server:\n  port: 8080\n  read_timeout: ${fmt}\n  write_timeout: 10s` }, question: `Is the server read_timeout at most ${bound >= 60000 ? "one minute" : "one second"}?`, truth: ms <= bound, rules: "Durations use ms, s or m suffixes.", facts: { read_timeout_ms: ms } };
    },
    nested() {
      const on = rnd() < 0.5;
      const obj = { app: { name: "shop", features: { audit: { enabled: rnd() < 0.5 } } }, security: { audit: { enabled: on, sink: "s3" } } };
      return { files: { "config.json": JSON.stringify(obj, null, 2) }, question: "Is security auditing enabled (security.audit.enabled is true)?", truth: on, rules: "JSON; only the path security.audit.enabled matters.", facts: { "security.audit.enabled": on } };
    },
    range() {
      const target = 22, rules = [];
      let covered = false;
      for (let i = 0; i < int(2, 5); i++) {
        const lo = pick([20, 21, 22, 23, 80, 443, 1000]), hi = lo + pick([0, 0, 1, 2, 10, 100]);
        const cidr = pick(["0.0.0.0/0", "10.0.0.0/8", "192.168.1.0/24"]);
        rules.push(`allow tcp ${lo === hi ? lo : `${lo}-${hi}`} from ${cidr}`);
        if (cidr === "0.0.0.0/0" && lo <= target && target <= hi) covered = true;
      }
      const expanded = rules.map(r => { const [, lo, hi, cidr] = r.match(/tcp (\d+)(?:-(\d+))? from (\S+)/); return { from: cidr, ports_covered_include_22: Number(lo) <= 22 && 22 <= Number(hi ?? lo) }; });
      return { files: { "firewall.rules": rules.join("\n") }, question: "Is SSH (tcp port 22) open to the whole internet (0.0.0.0/0)?", truth: covered, rules: "A rule 'lo-hi' covers every port from lo to hi inclusive.", facts: { rules: expanded } };
    },
    default() {
      const set = rnd() < 0.5, v = pick(["yes", "no"]);
      return { files: { "redis.conf": `port 6379\n${set ? `protected-mode ${v}` : "bind 127.0.0.1"}` }, question: "Is Redis protected mode on?", truth: set ? v === "yes" : true, rules: "protected-mode defaults to yes when not set.", facts: { effective_protected_mode: set ? v : "yes (default)" } };
    }
  };
  const names = Object.keys(fam);
  return { families: names, next: (f = pick(names)) => ({ family: f, ...fam[f]() }) };
}

/** Per-family structured criteria and focus, written once (what a gate author would write). */
export const FAMILY_HINTS = {
  units: { focus: "the maxmemory directive in `files.redis.conf`", true: { what: "maxmemory converts to 1073741824 bytes or more" }, false: { what: "maxmemory converts to fewer than 1073741824 bytes", not_for: "values that only look small because of a larger unit" } },
  override: { focus: "every appendonly line in `files.redis.conf`", true: { what: "the last uncommented appendonly line says yes" }, false: { what: "the last uncommented appendonly line says no, or there is none", not_for: "commented-out lines" } },
  count: { focus: "the role of each entry in `files.users.yaml`", true: { what: "the number of entries with role exactly admin meets the bound" }, false: { what: "fewer entries have role exactly admin", not_for: "roles that merely contain the word admin" } },
  xref: { focus: "the TLS environment entry in `files.docker-compose.yml` and the variable it references in `files.app.env`", true: { what: "the referenced variable is true" }, false: { what: "the referenced variable is false", not_for: "similarly named variables that are not referenced" } },
  duration: { focus: "read_timeout in `files.service.yaml`", true: { what: "read_timeout converts to no more than the bound" }, false: { what: "read_timeout exceeds the bound" } },
  nested: { focus: "`files.config.json` at security.audit.enabled", true: { what: "security.audit.enabled is true" }, false: { what: "security.audit.enabled is false", not_for: "app.features.audit" } },
  range: { focus: "each allow rule in `files.firewall.rules`", true: { what: "some rule from 0.0.0.0/0 has a port range that includes 22" }, false: { what: "no rule from 0.0.0.0/0 includes port 22", not_for: "rules from private ranges" } },
  default: { focus: "the protected-mode directive in `files.redis.conf`", true: { what: "protected-mode is yes, or not set (default yes)" }, false: { what: "protected-mode is explicitly no" } }
};
