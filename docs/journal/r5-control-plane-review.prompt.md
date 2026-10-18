You are reviewing the security of a multi-tenant control plane for a Cloudflare Worker. Below are two files: worker/control.mjs (API keys, scopes, rate limits, settings) and worker/index.mjs (routing, a Durable Object per "lattice", audit log, quotas).

Threat model: tenants hold their own API keys and must not read or modify other tenants' lattices, escalate scope (read < verify < admin), manage keys, bypass quotas, or forge/erase audit entries. The root key (env.JEV_API_KEY) is trusted.

List concrete vulnerabilities only. For each: the exact code path, a concrete request sequence that exploits it, severity (high/medium/low), and a minimal fix. Do not list style issues or generic advice. If you are not sure something is exploitable, say so explicitly. Reply in Markdown, at most 10 findings, most severe first.
