import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AppConfig, AlertChannel, CameraConfig } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");
// Writable data location. Defaults next to the app, but a packaged desktop build
// (read-only install dir) sets PW_DATA_DIR to a per-user folder.
export const DATA_DIR = process.env.PW_DATA_DIR || join(ROOT, "data");
const CONFIG_FILE = process.env.PW_CONFIG || join(DATA_DIR === join(ROOT, "data") ? ROOT : DATA_DIR, "config.json");

// Every option has a default, so config.json is entirely OPTIONAL — it can be `{}`,
// absent, or a partial override. The GUI (/settings) is the primary way to configure;
// config.json + env vars are there for headless / API use.
const DEFAULTS: AppConfig = {
  server: { port: 8787, host: "127.0.0.1" },
  cameras: [],
  image: { maxSize: 1024, crop: null, normalize: true, grayscale: false },
  ai: { provider: "ollama", baseUrl: "http://localhost:11434", model: "gemma3:4b", temperature: 0, numCtx: 4096 },
  check: { samples: 2, frames: 2, frameDelayMs: 4000, confidenceThreshold: 0.6, sampleTemperature: 0.6 },
  confirm: { enabled: false, models: [], samplesPerJuror: 1 },
  printer: { webLookup: true, searchEndpoint: "https://html.duckduckgo.com/html/", maxResults: 5 },
  alerts: { enabled: false, notifyUncertain: false, cooldownMinutes: 15, channels: [] },
  mcp: { enabled: false, target: "" },
  webcam: { enabled: true, fps: 5 },
};

/** Recursively drop "comment" keys so docs in config.json don't leak into the API. */
function stripComments(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(stripComments);
  if (o && typeof o === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === "comment") continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return o;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Deep-merge `src` onto a copy of `base`. Arrays and scalars from src replace. */
function deepMerge<T>(base: T, src: unknown): T {
  if (!isObj(base) || !isObj(src)) return (src === undefined ? base : (src as T));
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(src)) {
    out[k] = isObj(v) && isObj((base as Record<string, unknown>)[k]) ? deepMerge((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

function readRawFile(): Record<string, unknown> {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return stripComments(JSON.parse(readFileSync(CONFIG_FILE, "utf8"))) as Record<string, unknown>;
  } catch (e) {
    console.error(`[config] could not parse ${CONFIG_FILE}: ${(e as Error).message} — using defaults`);
    return {};
  }
}

function load(): AppConfig {
  const raw = deepMerge(DEFAULTS, readRawFile());
  raw.alerts.channels ??= [];
  raw.cameras = normalizeCameras(raw);
  // Env overrides for the things you most often tweak without editing anything.
  if (process.env.PW_CAMERA_URL) raw.cameras[0].url = process.env.PW_CAMERA_URL;
  if (process.env.PW_CAMERA_TYPE) raw.cameras[0].type = process.env.PW_CAMERA_TYPE as CameraConfig["type"];
  if (process.env.PW_MODEL) raw.ai.model = process.env.PW_MODEL;
  if (process.env.PW_OLLAMA_URL) raw.ai.baseUrl = process.env.PW_OLLAMA_URL;
  if (process.env.PW_AI_PROVIDER) raw.ai.provider = process.env.PW_AI_PROVIDER as AppConfig["ai"]["provider"];
  const geminiKey = process.env.PW_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (geminiKey) raw.ai.apiKey = geminiKey;
  if (process.env.PW_PORT) raw.server.port = Number(process.env.PW_PORT);
  applyAlertEnv(raw.alerts.channels);
  if (process.env.PW_ALERTS_ENABLED) raw.alerts.enabled = process.env.PW_ALERTS_ENABLED !== "false";
  else if (raw.alerts.channels.some((c) => c.enabled)) raw.alerts.enabled = true;
  if (process.env.PW_MCP_ENABLED) raw.mcp.enabled = process.env.PW_MCP_ENABLED !== "false";
  raw.mcp.target = process.env.PW_MCP_TARGET || raw.mcp.target || `http://${raw.server.host}:${raw.server.port}`;
  return raw;
}

/**
 * Resolve the camera list. Accepts the new `cameras: []` array or the legacy single
 * `camera` object (folded in), then fills stable ids/labels and de-duplicates ids.
 * An empty list is fine — the dashboard loads and the GUI can add cameras.
 */
function normalizeCameras(raw: AppConfig): CameraConfig[] {
  const list = Array.isArray(raw.cameras) && raw.cameras.length ? raw.cameras : raw.camera ? [raw.camera] : [];
  const seen = new Set<string>();
  return list.map((cam, i) => {
    let id = (cam.id || slugify(cam.label) || `cam${i + 1}`).trim();
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    return { ...cam, id, label: cam.label || cam.id || `Camera ${i + 1}` };
  });
}

const slugify = (s?: string) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Inject alert secrets from the environment so tokens/URLs never live in the
 * committed config. Each env-provided credential enables (or creates) its channel.
 */
function applyAlertEnv(channels: AlertChannel[]): void {
  const upsert = (match: Partial<AlertChannel>, patch: Partial<AlertChannel>) => {
    let ch = channels.find((c) => c.type === match.type && c.mode === match.mode);
    if (!ch) {
      ch = { type: match.type!, mode: match.mode!, enabled: false };
      channels.push(ch);
    }
    Object.assign(ch, patch, { enabled: true });
  };
  if (process.env.PW_SLACK_WEBHOOK) upsert({ type: "slack", mode: "webhook" }, { webhookUrl: process.env.PW_SLACK_WEBHOOK });
  if (process.env.PW_DISCORD_WEBHOOK) upsert({ type: "discord", mode: "webhook" }, { webhookUrl: process.env.PW_DISCORD_WEBHOOK });
  if (process.env.PW_SLACK_BOT_TOKEN)
    upsert({ type: "slack", mode: "bot" }, { token: process.env.PW_SLACK_BOT_TOKEN, channel: process.env.PW_SLACK_CHANNEL });
  if (process.env.PW_DISCORD_BOT_TOKEN)
    upsert({ type: "discord", mode: "bot" }, { token: process.env.PW_DISCORD_BOT_TOKEN, channel: process.env.PW_DISCORD_CHANNEL });
}

export const config = load();

// ---- GUI / API config editing ----

const SECRET = "••••••"; // shown in place of a stored secret; sending it back keeps the old value

/** Config for the API/GUI with secrets masked — safe to expose. */
export function publicConfig(): AppConfig {
  const c = JSON.parse(JSON.stringify(config)) as AppConfig;
  delete c.camera;
  if (c.ai.apiKey) c.ai.apiKey = SECRET;
  for (const ch of c.alerts.channels) {
    if (ch.token) ch.token = SECRET;
    if (ch.webhookUrl) ch.webhookUrl = SECRET;
  }
  return c;
}

/** Fields that only take effect on restart (everything else applies live). */
const RESTART_KEYS = ["cameras", "server", "mcp"] as const;

/**
 * Apply a partial config patch from the GUI: mutate the live `config` object IN
 * PLACE (so providers/analysis that hold a reference pick it up immediately),
 * persist to disk, and report which changes need a restart. Masked secrets sent
 * back unchanged keep their stored value.
 */
export function saveConfig(patch: Partial<AppConfig>): { restartRequired: string[] } {
  const c = config as unknown as Record<string, unknown>;
  const restart = new Set<string>();
  for (const key of RESTART_KEYS) {
    if (patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(c[key])) restart.add(key);
  }

  // Preserve secrets when the GUI echoes the mask back.
  if (patch.ai?.apiKey === SECRET) patch.ai.apiKey = config.ai.apiKey;
  if (patch.alerts?.channels) {
    for (const ch of patch.alerts.channels) {
      const prev = config.alerts.channels.find((p) => p.type === ch.type && p.mode === ch.mode);
      if (ch.token === SECRET) ch.token = prev?.token;
      if (ch.webhookUrl === SECRET) ch.webhookUrl = prev?.webhookUrl;
    }
  }

  // Mutate in place, section by section, so existing object references stay valid.
  for (const [k, v] of Object.entries(patch)) {
    if (k === "cameras") continue; // re-normalized below
    const cur = c[k];
    if (isObj(cur) && isObj(v)) Object.assign(cur, v);
    else c[k] = v;
  }
  if (patch.cameras) {
    config.cameras.length = 0;
    config.cameras.push(...normalizeCameras({ ...config, cameras: patch.cameras }));
  }

  persist();
  return { restartRequired: [...restart] };
}

function persist() {
  try {
    const toWrite: Partial<AppConfig> = { ...config };
    delete toWrite.camera;
    writeFileSync(CONFIG_FILE, JSON.stringify(toWrite, null, 2));
  } catch (e) {
    console.error(`[config] could not write ${CONFIG_FILE}: ${(e as Error).message}`);
  }
}
