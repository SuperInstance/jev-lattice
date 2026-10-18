/**
 * Capacity-aware harness for JEV Lattice
 *
 * Probes local resources and returns a policy tier that controls
 * how aggressive consolidation and proof-search may be.
 * System-agnostic: works in Node; browser can pass overrides.
 */

import os from "node:os";
import fs from "node:fs";

const TIERS = {
  minimal: {
    tier: "minimal",
    allowConsolidate: true,
    maxNodesSoft: 200,
    preferredProofSources: ["DETERMINISTIC_PARSER", "LATTICE_READ", "SENSOR"],
    consolidateOpts: { pruneFloor: 0.12, mergeDistance: 0.15, stitchRadius: 0.35 },
    description: "Low memory / constrained — prefer binary gates and cheap proofs"
  },
  standard: {
    tier: "standard",
    allowConsolidate: true,
    maxNodesSoft: 5000,
    preferredProofSources: [
      "DETERMINISTIC_PARSER",
      "LATTICE_READ",
      "SENSOR",
      "SMALL_MODEL",
      "LLM_CHAIN_OF_THOUGHT"
    ],
    consolidateOpts: { pruneFloor: 0.08, mergeDistance: 0.18, stitchRadius: 0.45 },
    description: "Laptop / small edge — full question graph, moderate consolidation"
  },
  high: {
    tier: "high",
    allowConsolidate: true,
    maxNodesSoft: 50000,
    preferredProofSources: [
      "DETERMINISTIC_PARSER",
      "LATTICE_READ",
      "SENSOR",
      "SMALL_MODEL",
      "LLM_CHAIN_OF_THOUGHT"
    ],
    consolidateOpts: { pruneFloor: 0.05, mergeDistance: 0.2, stitchRadius: 0.55 },
    description: "Desktop / GPU host — aggressive stitch, deeper retention"
  }
};

function bytesToGB(n) {
  return Math.round((n / 1024 / 1024 / 1024) * 100) / 100;
}

/**
 * Probe capacity. Override with env:
 *   JEV_TIER=minimal|standard|high
 *   JEV_FORCE_RAM_GB=8
 */
export function probeCapacity() {
  const forced = process.env.JEV_TIER;
  if (forced && TIERS[forced]) {
    return {
      forced: true,
      tier: forced,
      freeMemGB: bytesToGB(os.freemem()),
      totalMemGB: bytesToGB(os.totalmem()),
      cpus: os.cpus()?.length || 1,
      platform: os.platform(),
      load: os.loadavg?.()?.[0] ?? null
    };
  }

  const totalMemGB = bytesToGB(os.totalmem());
  const freeMemGB = bytesToGB(os.freemem());
  const cpus = os.cpus()?.length || 1;
  const load = os.loadavg?.()?.[0] ?? 0;

  let tier = "standard";
  if (totalMemGB < 4 || freeMemGB < 1) tier = "minimal";
  else if (totalMemGB >= 16 && cpus >= 6) tier = "high";

  // Thermal / load pressure → don't promote
  if (load > cpus * 1.5 && tier === "high") tier = "standard";

  return {
    forced: false,
    tier,
    freeMemGB,
    totalMemGB,
    cpus,
    platform: os.platform(),
    load: Math.round(load * 100) / 100,
    stateDirWritable: isWritable(process.cwd())
  };
}

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function createHarness(overrides = {}) {
  let lastProbe = null;

  function snapshot() {
    lastProbe = { ...probeCapacity(), ...overrides, probedAt: new Date().toISOString() };
    const policy = { ...TIERS[lastProbe.tier] };
    return {
      capacity: lastProbe,
      policy,
      schemaNote: "Harness only sets intensity; lattice schema is unchanged"
    };
  }

  function policy() {
    if (!lastProbe) snapshot();
    return { ...TIERS[lastProbe.tier] };
  }

  return { probeCapacity, snapshot, policy, TIERS };
}

export { TIERS };
