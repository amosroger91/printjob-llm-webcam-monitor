const $ = (id) => document.getElementById(id);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString();

// ---------- live preview ----------
let previewTimer = null;
function refreshPreview() {
  if (!$("autorefresh").checked) return;
  $("preview").src = `/api/snapshot?t=${Date.now()}`;
}
$("preview").addEventListener("error", () => {
  $("preview").alt = "no camera frame — check config.json camera.url";
});
$("autorefresh").addEventListener("change", refreshPreview);
previewTimer = setInterval(refreshPreview, 5000);
refreshPreview();

// ---------- status ----------
async function loadStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    const ok = s.ai.ok;
    $("status").innerHTML =
      `<span class="dot ${ok ? "ok" : "bad"}"></span>` +
      `${s.ai.name} · ${s.cameraKind} · ${s.check.frames}×${s.check.samples} checks` +
      (ok ? "" : ` — ${s.ai.detail}`);
  } catch {
    $("status").textContent = "server unreachable";
  }
}
loadStatus();

// ---------- activity log via SSE ----------
function logLine(msg) {
  const d = document.createElement("div");
  d.textContent = `${fmtTime(Date.now())}  ${msg}`;
  $("log").prepend(d);
}
const es = new EventSource("/api/events");
es.onmessage = (e) => {
  const evt = JSON.parse(e.data);
  switch (evt.type) {
    case "check:progress": logLine(evt.data.msg); $("checkProgress").textContent = evt.data.msg; break;
    case "check:start": logLine("check started"); break;
    case "check:done": logLine(`check done: ${evt.data.verdict}`); break;
    case "check:error": logLine(`check error: ${evt.data.error}`); break;
    case "alert": logLine(`⚠ ALERT: ${evt.data.summary}`); break;
    case "printer:start": logLine("printer detection started"); break;
    case "printer:progress": logLine(evt.data.msg); $("printerProgress").textContent = evt.data.msg; break;
    case "printer:done": logLine(`printer: ${evt.data.brand} ${evt.data.model} (${evt.data.kinematics})`); break;
    case "printer:error": logLine(`printer-detect error: ${evt.data.error}`); break;
    case "bed:start": logLine("bed-state read started"); break;
    case "bed:progress": logLine(evt.data.msg); $("bedProgress").textContent = evt.data.msg; break;
    case "bed:done": logLine(`bed state: ${evt.data.state}`); break;
    case "bed:error": logLine(`bed-state error: ${evt.data.error}`); break;
    case "ts:start": logLine(`investigating: ${evt.data.symptom}`); break;
    case "ts:diagnosed": logLine(`diagnosis ready (${evt.data.suggestions.length} suggestions)`); break;
    case "ts:verifying": logLine("verifying outcome…"); break;
    case "ts:verified": logLine(`verification: ${evt.data.observations.at(-1)?.verdict}`); break;
  }
};

// ---------- use case 1: failure check ----------
$("checkBtn").addEventListener("click", async () => {
  $("checkBtn").disabled = true;
  $("checkProgress").textContent = "starting…";
  $("checkResult").className = "result empty";
  $("checkResult").textContent = "running double-checked inspection…";
  try {
    const r = await (await fetch("/api/check", { method: "POST" })).json();
    if (r.error) throw new Error(r.error);
    renderCheck(r);
    loadHistory();
  } catch (e) {
    $("checkResult").className = "result";
    $("checkResult").textContent = "error: " + e.message;
  } finally {
    $("checkBtn").disabled = false;
    $("checkProgress").textContent = "";
  }
});

function verdictLabel(v) {
  return v === "ok" ? "✓ Looks healthy" : v === "failed" ? "✕ Likely failure" : "? Uncertain";
}

function renderCheck(r) {
  const el = $("checkResult");
  el.className = "result";
  const conf = Math.round(r.confidence * 100);
  const issues = r.issues.length
    ? `<div class="tags">${r.issues.map((i) => `<span class="tag ${i.severity}">${i.type} · ${i.severity}</span>`).join("")}</div>`
    : "";
  const thumbs = r.snapshotPaths.map((p) => `<img src="${p}" />`).join("");
  el.innerHTML = `
    <div class="verdict ${r.verdict}">${verdictLabel(r.verdict)}</div>
    <div class="confbar"><span style="width:${conf}%"></span></div>
    <div>${r.summary}</div>
    ${issues}
    <p class="hint">Double-check: ${r.framesAnalyzed} frame(s) × ${r.samplesPerFrame} model passes = ${r.passes.length} votes.</p>
    <div class="thumbs">${thumbs}</div>`;
}

// ---------- history ----------
async function loadHistory() {
  try {
    const checks = await (await fetch("/api/checks")).json();
    if (!checks.length) { $("history").textContent = "No checks yet."; return; }
    $("history").innerHTML = checks
      .map(
        (c) =>
          `<div class="h-item"><span class="verdict ${c.verdict}" style="margin:0;padding:2px 8px;">${verdictLabel(c.verdict)}</span>` +
          `<span>${Math.round(c.confidence * 100)}% · ${c.issues.map((i) => i.type).join(", ") || "—"}</span>` +
          `<span class="when">${fmtTime(c.ts)}</span></div>`,
      )
      .join("");
  } catch {
    $("history").textContent = "—";
  }
}
loadHistory();

// ---------- use case 4: printer detection ----------
const KINE_LABEL = {
  bed_slinger: "Open-frame bed-slinger (i3)",
  corexy: "CoreXY (boxed)",
  delta: "Delta",
  other: "Other / non-standard",
  unknown: "Unknown type",
};

$("printerBtn").addEventListener("click", async () => {
  $("printerBtn").disabled = true;
  $("printerProgress").textContent = "starting…";
  $("printerResult").className = "result empty";
  $("printerResult").textContent = "identifying printer…";
  try {
    const r = await (await fetch("/api/printer", { method: "POST" })).json();
    if (r.error) throw new Error(r.error);
    renderPrinter(r);
  } catch (e) {
    $("printerResult").className = "result";
    $("printerResult").textContent = "error: " + e.message;
  } finally {
    $("printerBtn").disabled = false;
    $("printerProgress").textContent = "";
  }
});

function renderPrinter(r) {
  const el = $("printerResult");
  el.className = "result";
  const conf = Math.round(r.confidence * 100);
  const name =
    r.brand !== "unknown" && r.model !== "unknown"
      ? `${r.brand} ${r.model}`
      : r.brand !== "unknown"
        ? r.brand
        : "Unidentified make";
  const rows = [
    ["Type", KINE_LABEL[r.kinematics] || r.kinematics],
    ["Enclosure", r.enclosure],
    ["Visible text", r.visibleText || "—"],
  ]
    .map(([k, v]) => `<div class="field"><b>${k}:</b> ${v}</div>`)
    .join("");
  const via =
    r.identifiedVia === "web"
      ? `<span class="tag minor">🌐 web-identified</span>`
      : `<span class="tag">👁️ vision-only</span>`;
  const sources = (r.sources || []).length
    ? `<details class="sources"><summary>Sources (${r.sources.length})</summary>` +
      r.sources
        .map((s) => `<div class="src"><a href="${s.url}" target="_blank" rel="noopener">${s.title}</a></div>`)
        .join("") +
      `</details>`
    : "";
  el.innerHTML = `
    <div class="verdict ${r.confidence >= 0.6 ? "ok" : "uncertain"}">🖨️ ${name}</div>
    <div class="confbar"><span style="width:${conf}%"></span></div>
    <div>${r.summary}</div>
    <div class="tags">${via}</div>
    ${rows}
    ${sources}
    <p class="hint">${r.votes.length} pass(es) · ${conf}% agreed on form factor.</p>
    <div class="thumbs"><img src="${r.snapshotPath}" /></div>`;
}

// Surface the last printer identification on load.
(async () => {
  try {
    const s = await (await fetch("/api/status")).json();
    if (s.latestPrinter) renderPrinter(s.latestPrinter);
  } catch {}
})();

// ---------- use case 3: bed / job state ----------
const BED_LABEL = {
  empty: "🟢 Empty / clean",
  printing: "🖨️ Printing",
  complete: "✅ Complete",
  failed: "✕ Failed",
  unsure: "? Unsure",
};
// Reuse the verdict color classes: green for empty/complete, red for failed, amber otherwise.
const BED_CLASS = { empty: "ok", complete: "ok", printing: "uncertain", failed: "failed", unsure: "uncertain" };

$("bedBtn").addEventListener("click", async () => {
  $("bedBtn").disabled = true;
  $("bedProgress").textContent = "starting…";
  $("bedResult").className = "result empty";
  $("bedResult").textContent = "reading bed state…";
  try {
    const r = await (await fetch("/api/bed-state", { method: "POST" })).json();
    if (r.error) throw new Error(r.error);
    renderBed(r);
  } catch (e) {
    $("bedResult").className = "result";
    $("bedResult").textContent = "error: " + e.message;
  } finally {
    $("bedBtn").disabled = false;
    $("bedProgress").textContent = "";
  }
});

function renderBed(r) {
  const el = $("bedResult");
  el.className = "result";
  const conf = Math.round(r.confidence * 100);
  el.innerHTML = `
    <div class="verdict ${BED_CLASS[r.state] || "uncertain"}">${BED_LABEL[r.state] || r.state}</div>
    <div class="confbar"><span style="width:${conf}%"></span></div>
    <div>${r.summary}</div>
    <p class="hint">${r.votes.length} pass(es) · ${conf}% agreed on "${r.state}".</p>
    <div class="thumbs"><img src="${r.snapshotPath}" /></div>`;
}

// Surface the last bed-state reading on load.
(async () => {
  try {
    const s = await (await fetch("/api/status")).json();
    if (s.latestBedState) renderBed(s.latestBedState);
  } catch {}
})();

// ---------- use case 2: troubleshoot ----------
$("tsBtn").addEventListener("click", async () => {
  const symptom = $("symptom").value.trim();
  if (!symptom) return;
  $("tsBtn").disabled = true;
  $("tsResult").innerHTML = `<p class="hint">analyzing the print and diagnosing…</p>`;
  try {
    const s = await (await fetch("/api/troubleshoot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symptom }),
    })).json();
    if (s.error) throw new Error(s.error);
    renderSession(s);
  } catch (e) {
    $("tsResult").innerHTML = `<p class="hint">error: ${e.message}</p>`;
  } finally {
    $("tsBtn").disabled = false;
  }
});

function renderSession(s) {
  const sugg = (s.suggestions || [])
    .map(
      (g, i) => `
      <div class="suggestion">
        <h4>${i + 1}. ${g.hypothesis}</h4>
        <div class="field"><b>Change:</b> ${g.change}</div>
        <div class="field"><b>Expected:</b> ${g.expectedOutcome}</div>
        <div class="field"><b>Watch for:</b> ${g.watchFor}</div>
        <button data-session="${s.id}" data-idx="${i}" class="verifyBtn">I made this change — verify it worked</button>
        <div class="obs-slot"></div>
      </div>`,
    )
    .join("");
  $("tsResult").innerHTML = `<p class="hint">Baseline captured. Apply a change, then click verify to have the model watch the outcome.</p>${sugg}`;
  document.querySelectorAll(".verifyBtn").forEach((b) => b.addEventListener("click", onVerify));
}

async function onVerify(e) {
  const btn = e.currentTarget;
  const slot = btn.parentElement.querySelector(".obs-slot");
  btn.disabled = true;
  slot.innerHTML = `<p class="hint">capturing & comparing to baseline…</p>`;
  try {
    const s = await (await fetch(`/api/troubleshoot/${btn.dataset.session}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suggestionIndex: Number(btn.dataset.idx) }),
    })).json();
    if (s.error) throw new Error(s.error);
    const o = s.observations.at(-1);
    const cls = o.verdict === "improved" ? "ok" : o.verdict === "worse" ? "failed" : "uncertain";
    slot.innerHTML = `<div class="obs"><span class="verdict ${cls}" style="margin:0;padding:2px 8px;">${o.verdict}</span> ${o.note}
      <div class="thumbs"><img src="${o.snapshotPath}" /></div></div>`;
  } catch (err) {
    slot.innerHTML = `<p class="hint">error: ${err.message}</p>`;
  } finally {
    btn.disabled = false;
  }
}
