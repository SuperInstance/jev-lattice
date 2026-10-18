// Written by MiniMax-M3.1-Flash-Preview from docs/journal/round3-tfgen-prompt-v3.txt; reviewed + validated by experiments/tf-gen-check.mjs
export function makeTfGenerator(seed) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;

  return function genPlan(n) {
    const types = ["aws_instance", "aws_security_group", "aws_s3_bucket", "aws_iam_policy", "aws_db_instance"];
    const resources = [];
    const pick = (type) => {
      const candidates = type ? resources.filter((r) => r.type === type) : resources;
      return candidates.length ? candidates[Math.floor(rnd() * candidates.length)] : undefined;
    };

    for (let i = 0; i < n; i++) {
      const type = types[i % types.length];
      const after = {
        tags: { env: "prod", owner: "team-x" },
        ...(type === "aws_security_group" ? { ingress: [
          { from_port: 443, to_port: 443, protocol: "tcp", cidr_blocks: ["0.0.0.0/0"] },
          { from_port: 22, to_port: 22, protocol: "tcp", cidr_blocks: ["10.0.0.0/8"] },
        ] } : {}),
        ...(type === "aws_s3_bucket" ? { acl: "private" } : {}),
        ...(type === "aws_iam_policy" ? { policy: JSON.stringify({
          Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::b/*" }],
        }) } : {}),
        ...(type === "aws_db_instance" ? { deletion_protection: true, storage_encrypted: true } : {}),
      };
      const actions = rnd() < 0.6 ? ["no-op"] : ["update"];
      resources.push({ address: `${type}.r${i}`, type, change: { actions, after } });
    }

    if (rnd() < 0.45) {
      const target = pick();
      if (target) target.change.actions = rnd() < 0.5 ? ["delete", "create"] : ["delete"];
    }

    if (rnd() < 0.45) {
      const target = pick("aws_security_group");
      if (target) {
        const rule = rnd() < 0.3
          ? { from_port: 0, to_port: 65535, protocol: "tcp", cidr_blocks: ["0.0.0.0/0"] }
          : { from_port: 22, to_port: 22, protocol: "tcp", cidr_blocks: ["0.0.0.0/0"] };
        target.change.after.ingress.push(rule);
      }
    }

    if (rnd() < 0.45) {
      const target = pick();
      if (target) delete target.change.after.tags[rnd() < 0.5 ? "owner" : "env"];
    }

    if (rnd() < 0.45) {
      const target = pick("aws_s3_bucket");
      if (target) target.change.after.acl = "public-read";
    }

    if (rnd() < 0.45) {
      const target = pick("aws_iam_policy");
      if (target) target.change.after.policy = JSON.stringify({
        Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
      });
    }

    if (rnd() < 0.45) {
      const target = pick("aws_db_instance");
      if (target) target.change.after.deletion_protection = false;
    }

    if (rnd() < 0.45) {
      const count = Math.min(n, 4 + Math.floor(rnd() * 3));
      const picked = new Set();
      while (picked.size < count) picked.add(Math.floor(rnd() * n));
      for (const index of picked) resources[index].change.actions = ["create"];
    }

    const truth = {
      destroyed: resources.some((r) => r.change.actions.includes("delete")),
      sshPublic: resources.some((r) => r.type === "aws_security_group" && r.change.after.ingress?.some((rule) =>
        rule.from_port <= 22 && 22 <= rule.to_port && rule.cidr_blocks?.includes("0.0.0.0/0")
      )),
      allTagged: resources.every((r) =>
        r.change.after.tags?.env !== undefined && r.change.after.tags?.owner !== undefined
      ),
      publicS3: resources.some((r) => r.type === "aws_s3_bucket" && r.change.after.acl === "public-read"),
      iamStar: resources.some((r) => {
        if (r.type !== "aws_iam_policy") return false;
        try {
          const policy = JSON.parse(r.change.after.policy);
          return policy.Statement.some((statement) => statement.Action === "*" && statement.Resource === "*");
        } catch {
          return false;
        }
      }),
      allDbProtected: resources.filter((r) => r.type === "aws_db_instance")
        .every((r) => r.change.after.deletion_protection === true),
      createsOver3: resources.filter((r) => r.change.actions.includes("create")).length > 3,
    };
    const plan = { format_version: "1.2", resource_changes: resources };
    return { plan, truth };
  };
}

export const TF_QUESTIONS = [
  ["Will any resource be destroyed (a delete action, including replacements)?", (truth) => truth.destroyed],
  ["Does any security group allow inbound SSH (port 22) from 0.0.0.0/0?", (truth) => truth.sshPublic],
  ["Does every resource have both an env tag and an owner tag after the change?", (truth) => truth.allTagged],
  ["Is any S3 bucket public-read after the change?", (truth) => truth.publicS3],
  ["Does any IAM policy grant Action * on Resource *?", (truth) => truth.iamStar],
  ["Do all database instances have deletion_protection enabled after the change?", (truth) => truth.allDbProtected],
  ["Are there more than 3 resources being created?", (truth) => truth.createsOver3],
];
