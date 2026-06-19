const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const CAM_TYPES = ["usb", "http-snapshot", "mjpeg", "folder"];
const CAM_FIELD = { usb: "usbDevice", "http-snapshot": "url", mjpeg: "url", folder: "folderPath" };
const CAM_PH = { usb: "video=USB 2.0 Camera", "http-snapshot": "http://host/snapshot", mjpeg: "http://host/stream", folder: "./incoming" };

let cfg = {};

const MODELS = {
  ollama: ["gemma3:4b", "qwen2.5vl:7b", "qwen2.5vl:3b", "llama3.2-vision:11b", "llava:7b", "moondream"],
  gemini: ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"],
};

function fillModels(provider, current) {
  const sel = $("ai_model");
  const list = [...MODELS[provider]];
  if (current && !list.includes(current)) list.unshift(current);
  sel.innerHTML = list.map((m) => `<option ${m === current ? "selected" : ""}>${esc(m)}</option>`).join("");
}

function applyProviderUI() {
  const p = $("ai_provider").value;
  $("ollamaUrlRow").style.display = p === "ollama" ? "" : "none";
  $("geminiKeyRow").style.display = p === "gemini" ? "" : "none";
  $("geminiNote").style.display = p === "gemini" ? "" : "none";
  $("dlModel").style.display = p === "ollama" ? "" : "none";
  $("sysbox").style.display = p === "ollama" ? "" : "none";
}

async function load() {
  cfg = await (await fetch("/api/config")).json();
  $("ai_provider").value = cfg.ai?.provider ?? "ollama";
  fillModels($("ai_provider").value, cfg.ai?.model ?? "");
  $("ai_baseUrl").value = cfg.ai?.baseUrl ?? "";
  $("ai_apiKey").value = cfg.ai?.apiKey ? cfg.ai.apiKey : "";
  applyProviderUI();
  loadSystem();
  $("check_samples").value = cfg.check?.samples ?? 2;
  $("check_frames").value = cfg.check?.frames ?? 2;
  $("check_frameDelayMs").value = cfg.check?.frameDelayMs ?? 4000;
  $("check_confidenceThreshold").value = cfg.check?.confidenceThreshold ?? 0.6;
  $("printer_webLookup").checked = !!cfg.printer?.webLookup;
  $("webcam_enabled").checked = !!cfg.webcam?.enabled;
  $("webcam_fps").value = cfg.webcam?.fps ?? 5;
  $("alerts_enabled").checked = !!cfg.alerts?.enabled;
  $("alerts_notifyUncertain").checked = !!cfg.alerts?.notifyUncertain;
  $("alerts_cooldownMinutes").value = cfg.alerts?.cooldownMinutes ?? 15;
  renderCameras();
  renderChannels();
}

// ---- cameras ----
function camRow(cam, i) {
  const type = cam.type || "usb";
  const field = CAM_FIELD[type];
  return `<div class="camrow" data-i="${i}">
    <input class="c-label" placeholder="Label" value="${esc(cam.label || "")}" style="width:130px" />
    <input class="c-id" placeholder="id" value="${esc(cam.id || "")}" style="width:90px" />
    <select class="c-type">${CAM_TYPES.map((t) => `<option ${t === type ? "selected" : ""}>${t}</option>`).join("")}</select>
    <input class="c-val" placeholder="${esc(CAM_PH[type])}" value="${esc(cam[field] || "")}" style="flex:1;min-width:160px" />
    <button class="small c-del">✕</button>
  </div>`;
}
function renderCameras() {
  $("cameras").innerHTML = (cfg.cameras || []).map(camRow).join("") || `<p class="hint">No cameras yet.</p>`;
  $("cameras").querySelectorAll(".c-del").forEach((b) =>
    b.addEventListener("click", (e) => {
      cfg.cameras.splice(Number(e.target.closest(".camrow").dataset.i), 1);
      renderCameras();
    }),
  );
  $("cameras").querySelectorAll(".c-type").forEach((s) =>
    s.addEventListener("change", (e) => {
      const row = e.target.closest(".camrow");
      const val = row.querySelector(".c-val");
      val.placeholder = CAM_PH[e.target.value];
    }),
  );
}
$("addCam").addEventListener("click", () => {
  cfg.cameras = cfg.cameras || [];
  cfg.cameras.push({ type: "usb", label: "", id: "" });
  renderCameras();
});

function collectCameras() {
  return [...$("cameras").querySelectorAll(".camrow")].map((row) => {
    const type = row.querySelector(".c-type").value;
    const cam = {
      label: row.querySelector(".c-label").value.trim(),
      id: row.querySelector(".c-id").value.trim(),
      type,
    };
    const v = row.querySelector(".c-val").value.trim();
    if (v) cam[CAM_FIELD[type]] = v;
    return cam;
  });
}

// ---- alert channels ----
function chanRow(ch, i) {
  const secretField = ch.mode === "bot" ? "token" : "webhookUrl";
  const secretLabel = ch.mode === "bot" ? "Bot token" : "Webhook URL";
  return `<div class="chanrow" data-i="${i}">
    <label class="chk"><input type="checkbox" class="ch-en" ${ch.enabled ? "checked" : ""} /> <b>${esc(ch.type)}</b> · ${esc(ch.mode)}</label>
    <input class="ch-secret" placeholder="${secretLabel}" value="${esc(ch[secretField] || "")}" style="flex:1;min-width:200px" />
    ${ch.mode === "bot" ? `<input class="ch-channel" placeholder="#channel / id" value="${esc(ch.channel || "")}" style="width:130px" />` : ""}
  </div>`;
}
function renderChannels() {
  const channels = cfg.alerts?.channels?.length
    ? cfg.alerts.channels
    : (cfg.alerts = cfg.alerts || {}).channels = [
        { type: "slack", mode: "webhook", enabled: false },
        { type: "slack", mode: "bot", enabled: false },
        { type: "discord", mode: "webhook", enabled: false },
        { type: "discord", mode: "bot", enabled: false },
      ];
  $("channels").innerHTML = channels.map(chanRow).join("");
}
function collectChannels() {
  return [...$("channels").querySelectorAll(".chanrow")].map((row, i) => {
    const base = cfg.alerts.channels[i];
    const ch = { type: base.type, mode: base.mode, enabled: row.querySelector(".ch-en").checked };
    const secret = row.querySelector(".ch-secret").value;
    if (base.mode === "bot") {
      ch.token = secret;
      ch.channel = row.querySelector(".ch-channel").value.trim();
    } else {
      ch.webhookUrl = secret;
    }
    return ch;
  });
}

// ---- save ----
$("save").addEventListener("click", async () => {
  $("save").disabled = true;
  $("saveMsg").textContent = "saving…";
  const patch = {
    cameras: collectCameras(),
    ai: {
      provider: $("ai_provider").value,
      model: $("ai_model").value.trim(),
      baseUrl: $("ai_baseUrl").value.trim(),
      apiKey: $("ai_apiKey").value.trim() || undefined,
    },
    check: {
      samples: Number($("check_samples").value),
      frames: Number($("check_frames").value),
      frameDelayMs: Number($("check_frameDelayMs").value),
      confidenceThreshold: Number($("check_confidenceThreshold").value),
    },
    printer: { webLookup: $("printer_webLookup").checked },
    webcam: { enabled: $("webcam_enabled").checked, fps: Number($("webcam_fps").value) },
    alerts: {
      enabled: $("alerts_enabled").checked,
      notifyUncertain: $("alerts_notifyUncertain").checked,
      cooldownMinutes: Number($("alerts_cooldownMinutes").value),
      channels: collectChannels(),
    },
  };
  try {
    const r = await (await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    })).json();
    if (r.error) throw new Error(r.error);
    cfg = r.config;
    const restart = (r.restartRequired || []).length
      ? ` ⚠ Restart to apply: ${r.restartRequired.join(", ")}.`
      : "";
    $("saveMsg").innerHTML = `✓ Saved.${restart}`;
    renderCameras();
    renderChannels();
  } catch (e) {
    $("saveMsg").textContent = "error: " + e.message;
  } finally {
    $("save").disabled = false;
  }
});

// ---- provider switch ----
$("ai_provider").addEventListener("change", () => {
  fillModels($("ai_provider").value, MODELS[$("ai_provider").value][0]);
  applyProviderUI();
});

// ---- system specs + suggested model ----
async function loadSystem() {
  try {
    const s = await (await fetch("/api/system")).json();
    const sug = s.suggestion;
    $("sysbox").innerHTML =
      `<div class="hint"><b>Your machine:</b> ${esc(s.platform)}/${esc(s.arch)} · ${s.cpuCount} cores · ${s.ramGb} GB RAM` +
      `<br>${esc(s.cpu)}</div>` +
      `<div class="suggest"><b>Suggested model:</b> <code>${esc(sug.model)}</code> — ${esc(sug.reason)} ` +
      `<button id="useSug" class="small" type="button">Use &amp; download</button></div>` +
      `<div class="hint">${esc(sug.note)}</div>`;
    $("useSug").addEventListener("click", () => {
      fillModels("ollama", sug.model);
      pullModel(sug.model);
    });
  } catch {
    $("sysbox").innerHTML = `<span class="hint">could not read system info</span>`;
  }
}

// ---- download an Ollama model with live progress ----
$("dlModel").addEventListener("click", () => pullModel($("ai_model").value.trim()));

async function pullModel(model) {
  if (!model) return;
  $("dlModel").disabled = true;
  $("dlProgress").textContent = `Downloading ${model}…`;
  try {
    const res = await fetch("/api/ollama/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line);
          if (p.error) throw new Error(p.error);
          const pct = p.total ? ` ${Math.round((100 * (p.completed || 0)) / p.total)}%` : "";
          $("dlProgress").textContent = `${model}: ${p.status}${pct}`;
        } catch {}
      }
    }
    $("dlProgress").textContent = `✓ ${model} downloaded — select it and Save.`;
  } catch (e) {
    $("dlProgress").textContent = `download error: ${e.message}`;
  } finally {
    $("dlModel").disabled = false;
  }
}

load();
