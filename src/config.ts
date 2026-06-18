import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AppConfig } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");
export const DATA_DIR = join(ROOT, "data");

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

function load(): AppConfig {
  const raw = stripComments(JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"))) as AppConfig;
  // Back-compat default for configs written before printer detection existed.
  raw.printer ??= { webLookup: true, searchEndpoint: "https://html.duckduckgo.com/html/", maxResults: 5 };
  // Env overrides for the things you most often tweak without editing the file.
  if (process.env.PW_CAMERA_URL) raw.camera.url = process.env.PW_CAMERA_URL;
  if (process.env.PW_CAMERA_TYPE) raw.camera.type = process.env.PW_CAMERA_TYPE as AppConfig["camera"]["type"];
  if (process.env.PW_MODEL) raw.ai.model = process.env.PW_MODEL;
  if (process.env.PW_OLLAMA_URL) raw.ai.baseUrl = process.env.PW_OLLAMA_URL;
  if (process.env.PW_PORT) raw.server.port = Number(process.env.PW_PORT);
  return raw as AppConfig;
}

export const config = load();
