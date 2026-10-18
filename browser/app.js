/**
 * JEV Lattice UI + global tool surface (v0.2 — question graph)
 */
import { JEVLattice, createToolRegistry, SCHEMA } from "../jev-core.js";

const lattice = new JEVLattice();
const tools = createToolRegistry(lattice);

window.JEV = {
  lattice,
  tools,
  SCHEMA,
  version: "0.2.0",
  call(name, args) {
    if (!tools[name]) throw new Error(`Unknown tool: ${name}`);
    return tools[name](args || {});
  }
};

const canvas = document.getElementById("lattice");
const ctx = canvas.getContext("2d");
const hudNodes = document.getElementById("hud-nodes");
const hudEdges = document.getElementById("hud-edges");
const hudLast = document.getElementById("hud-last");
const footState = document.getElementById("foot-state");
const expLog = document.getElementById("exp-log");
const nodeList = document.getElementById("node-list");
const toolResult = document.getElementById("tool-result");

let selectedId = null;
let lastAction = "—";

function log(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "entry " + kind;
  el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  expLog.prepend(el);
  while (expLog.children.length > 50) expLog.removeChild(expLog.lastChild);
}

function resize() {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function worldToScreen(coord) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const pad = 40;
  const x = pad + ((coord[0] + 1.4) / 2.8) * (w - pad * 2);
  const y = pad + ((coord[1] + 1.4) / 2.8) * (h - pad * 2);
  return [x, y];
}

function draw() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = "#21262d";
  ctx.lineWidth = 1;
  for (let i = -1; i <= 1; i += 0.5) {
    const [x1] = worldToScreen([i, -1.4]);
    ctx.beginPath();
    ctx.moveTo(x1, 0);
    ctx.lineTo(x1, h);
    ctx.stroke();
    const [, y1] = worldToScreen([-1.4, i]);
    ctx.beginPath();
    ctx.moveTo(0, y1);
    ctx.lineTo(w, y1);
    ctx.stroke();
  }

  const nodes = lattice.listNodes();

  ctx.lineWidth = 1.2;
  for (const n of nodes) {
    const [x1, y1] = worldToScreen(n.spatial_coordinate);
    for (const e of n.transition_probabilities || []) {
      const t = lattice.getNode(e.target_node_id);
      if (!t) continue;
      const [x2, y2] = worldToScreen(t.spatial_coordinate);
      const alpha = 0.15 + e.probability * 0.55;
      ctx.strokeStyle = `rgba(88, 166, 255, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  for (const n of nodes) {
    const [x, y] = worldToScreen(n.spatial_coordinate);
    const r = 6 + n.salience_score * 10;
    const isQ = n.node_type === "QUESTION";
    const gate = isQ ? lattice.evaluateGoNoGo(n.id) : null;
    const open = gate && gate.open;

    if (n.id === selectedId) {
      ctx.beginPath();
      ctx.arc(x, y, r + 7, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(188, 140, 255, 0.28)";
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(x, y, r + 3, 0, Math.PI * 2);
    ctx.strokeStyle = open
      ? `rgba(248, 81, 73, ${0.35 + n.epistemic_uncertainty * 0.5})`
      : `rgba(210, 153, 34, ${0.2 + n.epistemic_uncertainty * 0.55})`;
    ctx.lineWidth = open ? 2.5 : 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (n.id === selectedId) {
      ctx.fillStyle = "#bc8cff";
    } else if (isQ) {
      ctx.fillStyle = open ? "#8b3a3a" : "#6e3a9e";
    } else {
      const g = Math.floor(80 + n.salience_score * 140);
      ctx.fillStyle = `rgb(60, ${g}, 160)`;
    }
    ctx.fill();
    ctx.strokeStyle = "#e6edf3";
    ctx.lineWidth = 1;
    ctx.stroke();

    if (isQ && (n.active_proofs || []).length) {
      ctx.fillStyle = open ? "#f85149" : "#3fb950";
      ctx.beginPath();
      ctx.arc(x + r * 0.7, y - r * 0.7, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "8px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(n.active_proofs.length), x + r * 0.7, y - r * 0.7);
    }
  }

  let edgeCount = 0;
  let openGates = 0;
  for (const n of nodes) {
    edgeCount += (n.transition_probabilities || []).length;
    if (n.node_type === "QUESTION") {
      const g = lattice.evaluateGoNoGo(n.id);
      if (g.open) openGates++;
    }
  }
  hudNodes.textContent = nodes.length + (openGates ? ` (${openGates} open)` : "");
  hudEdges.textContent = edgeCount;
  hudLast.textContent = lastAction;
  footState.textContent = nodes.length
    ? `${nodes.length} nodes · v${lattice.version} · ${SCHEMA}`
    : "empty";
}

function refreshList() {
  nodeList.innerHTML = "";
  const nodes = lattice.listNodes().sort((a, b) => b.salience_score - a.salience_score);
  for (const n of nodes) {
    const gate = n.node_type === "QUESTION" ? lattice.evaluateGoNoGo(n.id) : null;
    const el = document.createElement("div");
    el.className = "node-item" + (n.id === selectedId ? " selected" : "");
    const badge =
      n.node_type === "QUESTION"
        ? gate && gate.open
          ? `<span style="color:var(--red)">OPEN</span>`
          : `<span style="color:var(--green)">GO</span>`
        : `<span style="color:var(--muted)">obs</span>`;
    el.innerHTML = `
      <div class="id">${n.id} · ${badge}</div>
      <div class="meta">sal ${n.salience_score.toFixed(2)} · unc ${n.epistemic_uncertainty.toFixed(2)} · proofs ${(n.active_proofs || []).length} · ${n.tags.slice(0, 3).join(", ") || "—"}</div>
      <div class="meta" style="margin-top:4px;color:var(--text)">${(n.text || "").slice(0, 90)}${(n.text || "").length > 90 ? "…" : ""}</div>
    `;
    el.onclick = () => selectNode(n.id);
    nodeList.appendChild(el);
  }
}

function selectNode(id) {
  selectedId = id;
  const n = lattice.getNode(id);
  const empty = document.getElementById("inspect-empty");
  const body = document.getElementById("inspect-body");
  if (!n) {
    empty.style.display = "block";
    body.style.display = "none";
    draw();
    refreshList();
    return;
  }
  empty.style.display = "none";
  body.style.display = "block";

  const gate = n.node_type === "QUESTION" ? lattice.evaluateGoNoGo(n.id) : null;
  document.getElementById("insp-id").textContent = n.id;
  document.getElementById("insp-meta").textContent =
    `${n.node_type} · sal ${n.salience_score.toFixed(2)} · unc ${n.epistemic_uncertainty.toFixed(2)} · access ${n.access_frequency || 0}` +
    (gate ? ` · ${gate.go ? "GO" : "NO-GO"} (${gate.reason})` : "");

  const edgesEl = document.getElementById("insp-edges");
  edgesEl.innerHTML = "";

  if (n.node_type === "QUESTION") {
    const proofHeader = document.createElement("div");
    proofHeader.style.cssText = "font-size:0.7rem;color:var(--muted);margin:6px 0 4px;";
    proofHeader.textContent = `Proofs (${(n.active_proofs || []).length}) · mode ${n.question_spec?.evaluation_mode || "—"} · need ${n.question_spec?.required_independent_proofs || 1}`;
    edgesEl.appendChild(proofHeader);
    for (const p of n.active_proofs || []) {
      const div = document.createElement("div");
      div.className = "node-item";
      div.style.cursor = "default";
      div.innerHTML = `<div class="id">${p.source_type}</div>
        <div class="meta">conf ${Number(p.confidence).toFixed(2)} · cost ${Number(p.cost_weight).toFixed(2)} · ${p.proof_id}</div>`;
      edgesEl.appendChild(div);
    }
  }

  const edgeHeader = document.createElement("div");
  edgeHeader.style.cssText = "font-size:0.7rem;color:var(--muted);margin:10px 0 4px;";
  edgeHeader.textContent = "Transitions";
  edgesEl.appendChild(edgeHeader);

  for (const e of n.transition_probabilities || []) {
    const t = lattice.getNode(e.target_node_id);
    const div = document.createElement("div");
    div.className = "node-item";
    div.innerHTML = `<div class="id">${e.target_node_id}</div>
      <div class="meta">P=${e.probability.toFixed(2)} · ${(e.conditional_trigger_tags || []).join(", ") || "—"}</div>
      <div class="meta">${t ? (t.text || "").slice(0, 60) : "(missing)"}</div>`;
    div.onclick = () => selectNode(e.target_node_id);
    edgesEl.appendChild(div);
  }
  if ((n.transition_probabilities || []).length === 0) {
    const d = document.createElement("div");
    d.style.cssText = "color:var(--muted);font-size:0.75rem";
    d.textContent = "No transitions yet. Run Idle Cycle.";
    edgesEl.appendChild(d);
  }

  const goBtn = document.getElementById("btn-gongo");
  if (goBtn) goBtn.style.display = n.node_type === "QUESTION" ? "inline-block" : "none";
  const addProofBtn = document.getElementById("btn-add-proof");
  if (addProofBtn) addProofBtn.style.display = n.node_type === "QUESTION" ? "inline-block" : "none";

  draw();
  refreshList();
}

function ingestFromUI() {
  const text = document.getElementById("exp-text").value.trim();
  const tags = document.getElementById("exp-tags").value
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const asQuestion = document.getElementById("exp-as-question")?.checked;
  const mode = document.getElementById("exp-mode")?.value || "BINARY";
  const required = Number(document.getElementById("exp-required")?.value) || 1;
  const threshold = Number(document.getElementById("exp-threshold")?.value) || 0.85;

  const args = { text, tags };
  if (asQuestion) {
    args.node_type = "QUESTION";
    args.question_spec = {
      evaluation_mode: mode,
      required_independent_proofs: required,
      confidence_threshold: threshold,
      intent: text.slice(0, 120)
    };
  }

  const res = tools.ingest(args);
  if (!res.ok) {
    log(res.error || "ingest failed", "err");
    return;
  }
  lastAction = asQuestion ? "ingest QUESTION" : "ingest";
  log(`spawned ${res.node.id} (${res.node.node_type})`, "ok");
  document.getElementById("exp-text").value = "";
  selectNode(res.node.id);
  draw();
  refreshList();
}

function runIdle() {
  const res = tools.consolidate({});
  lastAction = "consolidate";
  log(
    `idle: ${res.before}→${res.after} nodes, +${res.edgesAdded} edges, pruned ${res.pruned}, merged ${res.merged}, seeking ${res.seekingVerification}`,
    "ok"
  );
  draw();
  refreshList();
  if (selectedId && !lattice.getNode(selectedId)) {
    selectedId = null;
    selectNode(null);
  } else if (selectedId) {
    selectNode(selectedId);
  }
}

function runQuery() {
  const text = document.getElementById("exp-text").value.trim() || "caching layer configuration";
  const tags = document.getElementById("exp-tags").value
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const res = tools.query({ text, tags, topK: 5, beam: 4 });
  lastAction = `query ${res.latencyMs}ms`;
  log(`query path: ${res.path.map(p => p.id).join(" → ") || "(empty)"}`, "ok");
  if (res.context.length) selectNode(res.context[0].id);
  draw();
  refreshList();
  toolResult.textContent = JSON.stringify(res, null, 2);
}

function runGoNoGo() {
  if (!selectedId) return;
  const res = tools.evaluateGoNoGo({ id: selectedId });
  lastAction = res.go ? "GO" : "NO-GO";
  log(`${selectedId}: ${res.go ? "GO" : "NO-GO"} — ${res.reason}`, res.go ? "ok" : "warn");
  toolResult.textContent = JSON.stringify(res, null, 2);
  selectNode(selectedId);
}

function addCheapProof() {
  if (!selectedId) return;
  const n = lattice.getNode(selectedId);
  if (!n || n.node_type !== "QUESTION") {
    log("select a QUESTION node first", "warn");
    return;
  }
  const res = tools.addProof({
    id: selectedId,
    proof: {
      source_type: "DETERMINISTIC_PARSER",
      confidence: 0.97,
      cost_weight: 0.02,
      note: "manual cheap proof (PoC)"
    }
  });
  lastAction = "addProof";
  log(`proof added → ${res.proofCount} total`, "ok");
  selectNode(selectedId);
}

function seedDemo() {
  tools.ingest({
    text: "Configured Redis caching layer on port 6379 for agent session store",
    tags: ["caching", "redis", "config"]
  });
  tools.ingest({
    text: "VRAM allocation error when loading BF16 memory model — fell back to FP4",
    tags: ["vram", "hardware_error", "bf16"]
  });
  tools.ingest({
    text: "Thermal throttle detected during background diffusion pass",
    tags: ["thermal", "hardware", "diffusion"]
  });

  const q1 = tools.ingest({
    text: "Verify custom agent caching layer is correctly configured for production",
    tags: ["caching", "config", "verify"],
    node_type: "QUESTION",
    question_spec: {
      evaluation_mode: "COORDINATED",
      required_independent_proofs: 2,
      confidence_threshold: 0.88,
      intent: "caching layer production readiness"
    },
    proof: {
      source_type: "LLM_CHAIN_OF_THOUGHT",
      confidence: 0.91,
      cost_weight: 0.85,
      note: "initial heavy CoT"
    }
  });

  tools.ingest({
    text: "Is REDIS_TLS_PORT set to 6380?",
    tags: ["config", "port", "binary"],
    node_type: "QUESTION",
    question_spec: {
      evaluation_mode: "BINARY",
      required_independent_proofs: 1,
      confidence_threshold: 0.9,
      intent: "TLS port check"
    },
    proof: {
      source_type: "DETERMINISTIC_PARSER",
      confidence: 0.99,
      cost_weight: 0.01,
      note: "config file parse"
    }
  });

  tools.consolidate({});
  lastAction = "seed";
  log("seeded: observations + 1 open COORDINATED question + 1 closed BINARY", "ok");
  if (q1.ok) selectNode(q1.node.id);
  draw();
  refreshList();
}

function downloadState() {
  const state = tools.exportState();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `jev-lattice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  lastAction = "export";
  log("state downloaded", "ok");
}

function uploadState(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const state = JSON.parse(reader.result);
      const res = tools.importState(state);
      if (!res.ok) {
        log(res.error || "import failed", "err");
        return;
      }
      lastAction = "import";
      log(`imported ${res.nodes} nodes`, "ok");
      selectedId = null;
      draw();
      refreshList();
      selectNode(null);
    } catch (e) {
      log("invalid JSON: " + e.message, "err");
    }
  };
  reader.readAsText(file);
}

function clearLattice() {
  if (!confirm("Clear all nodes? Download state first if you need it.")) return;
  lattice.nodes.clear();
  lattice._touch();
  selectedId = null;
  lastAction = "clear";
  log("lattice cleared", "warn");
  draw();
  refreshList();
  selectNode(null);
}

function runToolFromUI() {
  const name = document.getElementById("tool-select").value;
  let args = {};
  const raw = document.getElementById("tool-args").value.trim();
  if (raw) {
    try {
      args = JSON.parse(raw);
    } catch (e) {
      toolResult.textContent = "JSON parse error: " + e.message;
      return;
    }
  }
  if (name === "importState" && args.nodes) args = { state: args };
  try {
    const res = window.JEV.call(name, args);
    toolResult.textContent = JSON.stringify(res, null, 2);
    lastAction = name;
    draw();
    refreshList();
    if (name === "ingest" && res.node) selectNode(res.node.id);
    if (name === "importState") {
      selectedId = null;
      selectNode(null);
    }
  } catch (e) {
    toolResult.textContent = String(e);
  }
}

canvas.addEventListener("click", (ev) => {
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  let hit = null;
  let hitD = 16;
  for (const n of lattice.listNodes()) {
    const [x, y] = worldToScreen(n.spatial_coordinate);
    const d = Math.hypot(x - mx, y - my);
    if (d < hitD) {
      hitD = d;
      hit = n;
    }
  }
  if (hit) selectNode(hit.id);
});

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("panel-" + tab.dataset.tab).classList.add("active");
  });
});

document.getElementById("btn-ingest").onclick = ingestFromUI;
document.getElementById("btn-idle").onclick = runIdle;
document.getElementById("btn-query").onclick = runQuery;
document.getElementById("btn-seed").onclick = seedDemo;
document.getElementById("btn-download").onclick = downloadState;
document.getElementById("btn-clear").onclick = clearLattice;
document.getElementById("btn-run-tool").onclick = runToolFromUI;
document.getElementById("btn-boost").onclick = () => {
  if (!selectedId) return;
  tools.boost({ id: selectedId, delta: 0.12 });
  selectNode(selectedId);
  log(`boosted ${selectedId}`, "ok");
};
document.getElementById("btn-prune-one").onclick = () => {
  if (!selectedId) return;
  tools.prune({ id: selectedId });
  log(`pruned ${selectedId}`, "warn");
  selectedId = null;
  selectNode(null);
  draw();
  refreshList();
};
document.getElementById("btn-gongo").onclick = runGoNoGo;
document.getElementById("btn-add-proof").onclick = addCheapProof;
document.getElementById("upload-state").addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) uploadState(f);
  e.target.value = "";
});

const toolSelect = document.getElementById("tool-select");
if (toolSelect) {
  toolSelect.innerHTML = [
    "ingest", "addProof", "evaluateGoNoGo", "query", "consolidate",
    "exportState", "importState", "listNodes", "getNode", "prune", "boost", "stats"
  ].map(t => `<option value="${t}">${t}</option>`).join("");
}

window.addEventListener("resize", resize);
resize();
refreshList();
log("JEV lattice v0.2 ready — question graph + go/no-go · tools on window.JEV", "ok");
