#!/usr/bin/env node
// Independent validation of the MiniMax-written tf-gen.mjs: my own truth implementation
// over many plans must agree with the generator's truth on every question; plus balance.
import { makeTfGenerator, TF_QUESTIONS } from "./tf-gen.mjs";

function myTruth(plan) {
  const rs = plan.resource_changes;
  const acts = r => r.change.actions;
  const after = r => r.change.after || {};
  return [
    rs.some(r => acts(r).includes("delete")),
    rs.some(r => (after(r).ingress || []).some(g => g.from_port <= 22 && g.to_port >= 22 && (g.cidr_blocks || []).includes("0.0.0.0/0"))),
    rs.every(r => after(r).tags && "env" in after(r).tags && "owner" in after(r).tags),
    rs.some(r => after(r).acl === "public-read"),
    rs.some(r => { try { return JSON.parse(after(r).policy || "{}").Statement?.some(s => s.Action === "*" && s.Resource === "*"); } catch { return false; } }),
    rs.filter(r => r.type === "aws_db_instance").every(r => after(r).deletion_protection === true),
    rs.filter(r => acts(r).includes("create")).length > 3
  ];
}

let mismatches = 0, total = 0;
for (const n of [5, 10, 50, 100, 300]) {
  const g = makeTfGenerator(17 + n);
  const yes = new Array(7).fill(0);
  const runs = n >= 100 ? 300 : 500;
  for (let i = 0; i < runs; i++) {
    const { plan, truth } = g(n);
    const mine = myTruth(plan);
    TF_QUESTIONS.forEach(([, f], j) => { total++; if (f(truth) !== mine[j]) mismatches++; if (mine[j]) yes[j]++; });
  }
  console.log(`n=${String(n).padStart(3)}  P(yes) per question: ${yes.map(y => (y / runs).toFixed(2)).join(" ")}`);
}
console.log(`\ntruth mismatches vs independent implementation: ${mismatches}/${total}`);
process.exit(mismatches ? 1 : 0);
