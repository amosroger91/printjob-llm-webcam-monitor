const $ = (id) => document.getElementById(id);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString();
const postJSON = async (url) => {
  const r = await fetch(url, { method: "POST" });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function logLine(msg) {
  const d = document.createElement("div");
  d.textContent = `${fmtTime(Date.now())}  ${msg}`;
  $("log").prepend(d);
}

// ---------- labels ----------
const HEALTH = { ok: ["✓ Healthy", "ok"], failed: ["✕ Failure", "failed"], uncertain: ["? Uncertain", "uncertain"] };
const BED = {
  empty: ["🟢 Empty", "ok"], printing: ["🖨️ Printing", "uncertain"], complete: ["✅ Complete", "ok"],
  failed: ["✕ Failed", "failed"], unsure: ["? Unsure", "uncertain"],
};
const KINE = { bed_slinger: "Bed-slinger", corexy: "CoreXY", delta: "Delta", other: "Other", unknown: "Unknown" };

// ---------- build the camera grid ----------
let cameras = [];
const camPreviewTimers = new Map();

function tileHtml(c) {
  return `
    <div class="cam" id="cam-${esc(c.id)}">
      <div class="cam-head"><b>${esc(c.label)}</b> <span class="muted">${esc(c.kind)}</span></div>
      <div class="frame"><img class="cam-img" alt="${esc(c.label)} preview" /></div>
      <div class="cam-status">
        <span class="badge" data-role="health">health —</span>
        <span class="badge" data-role="bed">bed —</span>
      </div>
      <div class="cam-printer muted"><span data-role="printer">printer —</span>
        <button class="small" data-id="${esc(c.id)}" data-act="id">Identify</button></div>
    </div>`;
}

async function loadCameras() {
  cameras = await (await fetch("/api/cameras")).json();
  $("camCount").textContent = cameras.length;
  $("grid").innerHTML = cameras.map(tileHtml).join("");
  cameras.forEach((c) => {
    const img = document.querySelector(`#cam-${cssEsc(c.id)} .cam-img`);
    const refresh = () => (img.src = `/api/snapshot?camera=${encodeURIComponent(c.id)}&t=${Date.now()}`);
    img.addEventListener("error", () => (img.alt = "no frame"));
    refresh();
    camPreviewTimers.set(c.id, setInterval(refresh, 3000));
    if (c.latest) renderHealth(c.id, c.latest);
    if (c.latestBedState) renderBed(c.id, c.latestBedState);
    if (c.latestPrinter) renderPrinter(c.id, c.latestPrinter);
  });
  document.querySelectorAll('[data-act="id"]').forEach((b) => b.addEventListener("click", () => identify(b.dataset.id)));
}

const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
const tile = (id) => $(`cam-${id}`) || document.querySelector(`#cam-${cssEsc(id)}`);
function setBadge(id, role, text, cls) {
  const el = tile(id)?.querySelector(`[data-role="${role}"]`);
  if (el) {
    el.className = `badge ${cls || ""}`;
    el.textContent = text;
  }
}

function renderHealth(id, r) {
  const [label, cls] = HEALTH[r.verdict] || ["—", ""];
  setBadge(id, "health", `${label} ${Math.round(r.confidence * 100)}%`, cls);
}
const noBed = {}; // cameraId -> true when no bed visible
function renderBed(id, r) {
  if (r.bedVisible === false) {
    setBadge(id, "bed", "⛔ No bed", "failed");
    noBed[id] = true;
  } else {
    const [label, cls] = BED[r.state] || ["—", ""];
    setBadge(id, "bed", label, cls);
    delete noBed[id];
  }
  updateNoBedOverlay();
}

function updateNoBedOverlay() {
  const ids = Object.keys(noBed);
  const ov = $("nobedOverlay");
  if (ids.length) {
    const names = ids.map((id) => cameras.find((c) => c.id === id)?.label || id);
    $("nobedWhich").textContent = ` — ${names.join(", ")}`;
    ov.classList.remove("hidden");
  } else {
    ov.classList.add("hidden");
  }
}
function renderPrinter(id, r) {
  const name = r.brand !== "unknown" && r.model !== "unknown" ? `${r.brand} ${r.model}` : r.brand !== "unknown" ? r.brand : "unidentified";
  const via = r.identifiedVia === "web" ? "🌐" : "👁️";
  const el = tile(id)?.querySelector('[data-role="printer"]');
  if (el) el.innerHTML = `${via} ${esc(name)} <span class="muted">· ${KINE[r.kinematics] || r.kinematics}</span>`;
}

async function identify(id) {
  const el = tile(id)?.querySelector('[data-role="printer"]');
  if (el) el.textContent = "identifying…";
  try {
    renderPrinter(id, await postJSON(`/api/printer?camera=${encodeURIComponent(id)}`));
  } catch (e) {
    if (el) el.textContent = "error: " + e.message;
  }
}

// ---------- monitoring loop (sequential across cameras) ----------
let running = false;
let busy = false;
let loopTimer = null;

async function runCycle() {
  if (busy) return;
  busy = true;
  $("cycleState").textContent = "Checking…";
  for (const c of cameras) {
    setBadge(c.id, "bed", "bed …", "");
    try {
      renderBed(c.id, await postJSON(`/api/bed-state?camera=${encodeURIComponent(c.id)}`));
    } catch (e) {
      setBadge(c.id, "bed", "bed err", "failed");
    }
    setBadge(c.id, "health", "health …", "");
    try {
      renderHealth(c.id, await postJSON(`/api/check?camera=${encodeURIComponent(c.id)}`));
    } catch (e) {
      setBadge(c.id, "health", "health err", "failed");
    }
  }
  $("lastRun").textContent = `· last checked ${fmtTime(Date.now())}`;
  $("cycleState").textContent = running ? "Monitoring." : "Idle.";
  busy = false;
}

function scheduleNext() {
  if (!running) return;
  const secs = Math.max(5, Number($("interval").value) || 30);
  loopTimer = setTimeout(async () => {
    await runCycle();
    scheduleNext();
  }, secs * 1000);
}

$("toggleBtn").addEventListener("click", async () => {
  running = !running;
  $("toggleBtn").textContent = running ? "⏸ Stop monitoring" : "▶ Start monitoring";
  $("toggleBtn").classList.toggle("primary", !running);
  if (running) {
    logLine("monitoring started");
    await runCycle();
    scheduleNext();
  } else {
    logLine("monitoring stopped");
    clearTimeout(loopTimer);
    $("cycleState").textContent = "Idle.";
  }
});
$("runBtn").addEventListener("click", () => runCycle());

// ---------- status + alerts ----------
async function loadStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    $("status").innerHTML = `<span class="dot ${s.ai.ok ? "ok" : "bad"}"></span>${s.ai.name}`;
  } catch {
    $("status").textContent = "server unreachable";
  }
}

async function loadAlerts() {
  try {
    const a = await (await fetch("/api/alerts")).json();
    const rows = (a.channels || [])
      .map((c) => `<div class="field"><b>${esc(c.label)}</b> — ${c.ready ? "✅ ready" : c.enabled ? "⚠ missing creds" : "off"}` +
        `${c.target ? ` <span class="muted">(${esc(c.target)})</span>` : ""}</div>`)
      .join("");
    $("alertStatus").className = "result";
    $("alertStatus").innerHTML =
      `<div class="field"><b>Alerts:</b> ${a.enabled ? "enabled" : "disabled"}${a.notifyUncertain ? " · also on uncertain" : ""}</div>` +
      (rows || '<p class="hint">No channels configured.</p>');
  } catch {
    $("alertStatus").textContent = "could not load alert status";
  }
}

$("testAlertBtn").addEventListener("click", async () => {
  $("testAlertBtn").disabled = true;
  try {
    const { results, error } = await (await fetch("/api/alerts/test", { method: "POST" })).json();
    if (error) throw new Error(error);
    (results || []).forEach((r) => logLine(`test → ${r.channel}: ${r.ok ? "ok" : "FAIL " + r.detail}`));
  } catch (e) {
    logLine(`test alert error: ${e.message}`);
  } finally {
    $("testAlertBtn").disabled = false;
  }
});

// ---------- SSE: route progress + results to the right tile ----------
const es = new EventSource("/api/events");
es.onmessage = (e) => {
  const evt = JSON.parse(e.data);
  const d = evt.data || {};
  switch (evt.type) {
    case "check:progress": if (d.cameraId) setBadge(d.cameraId, "health", "health …", ""); break;
    case "bed:progress": if (d.cameraId) setBadge(d.cameraId, "bed", "bed …", ""); break;
    case "check:done": if (d.result) renderHealth(d.cameraId, d.result); break;
    case "bed:done": if (d.result) renderBed(d.cameraId, d.result); break;
    case "alert:sent": (d.results || []).forEach((r) => logLine(`alert → ${r.channel}: ${r.ok ? "sent" : "FAIL " + r.detail}`)); break;
    case "alert:error": logLine(`alert error: ${d.error}`); break;
  }
};

loadCameras().catch((e) => logLine("failed to load cameras: " + e.message));
loadStatus();
loadAlerts();
