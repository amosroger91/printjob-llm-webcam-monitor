import { randomUUID } from "node:crypto";
import type { CaptureSource } from "../capture/index.js";
import type { VisionProvider } from "../ai/provider.js";
import { prepareImage } from "../image/preprocess.js";
import {
  PRINTER_SCHEMA,
  PRINTER_SYSTEM,
  printerUserPrompt,
  PRINTER_LOOKUP_SCHEMA,
  PRINTER_LOOKUP_SYSTEM,
  printerLookupUserPrompt,
  type RawPrinterJson,
  type RawPrinterLookupJson,
} from "../ai/prompts.js";
import { ddgSearch } from "../web/search.js";
import { store } from "../store/store.js";
import type {
  AppConfig,
  Enclosure,
  PrinterDetectionResult,
  PrinterDetectionVote,
  PrinterIdSource,
  PrinterKinematics,
  WebSource,
} from "../types.js";

/**
 * Identify the printer in view (kinematics · enclosure · make/model). Single frame,
 * `samples` self-consistency passes. Categorical fields (kinematics, enclosure) are
 * resolved by mode; free-text make/model by the most common non-"unknown" answer.
 * Confidence is the share of passes that agreed on the kinematics — the most
 * structural, reliable field.
 */
export async function runPrinterDetection(
  source: CaptureSource,
  ai: VisionProvider,
  cfg: AppConfig,
  onProgress?: (msg: string) => void,
): Promise<PrinterDetectionResult> {
  const id = randomUUID().slice(0, 8);
  const ts = Date.now();
  const samples = Math.max(1, cfg.check.samples);

  onProgress?.("Capturing frame…");
  const raw = await source.grab();
  const prepped = await prepareImage(raw, cfg.image);
  const snapshotPath = await store.saveSnapshot(`${id}-printer`, prepped.bytes);

  const votes: PrinterDetectionVote[] = [];
  for (let s = 0; s < samples; s++) {
    onProgress?.(`Identifying printer, pass ${s + 1}/${samples}…`);
    try {
      const json = await ai.json<RawPrinterJson>({
        system: PRINTER_SYSTEM,
        prompt: printerUserPrompt(),
        images: [prepped.base64],
        schema: PRINTER_SCHEMA as unknown as Record<string, unknown>,
        temperature: samples > 1 ? cfg.check.sampleTemperature : 0,
      });
      votes.push({
        kinematics: normalizeKinematics(json.kinematics),
        enclosure: normalizeEnclosure(json.enclosure),
        brand: clean(json.brand),
        model: clean(json.model),
        visibleText: clean(json.visible_text),
        reasoning: clean(json.reasoning),
      });
    } catch (e) {
      onProgress?.(`pass error: ${(e as Error).message}`);
    }
  }
  if (votes.length === 0) throw new Error("all model passes failed for printer detection");

  const kinematics = mode(votes.map((v) => v.kinematics)) as PrinterKinematics;
  const enclosure = mode(votes.map((v) => v.enclosure)) as Enclosure;
  let brand = bestText(votes.map((v) => v.brand));
  let model = bestText(votes.map((v) => v.model));
  const visibleText = bestText(votes.map((v) => v.visibleText));
  const confidence = clamp01(votes.filter((v) => v.kinematics === kinematics).length / votes.length);

  // Web lookup: the model can read the on-machine text but not map it to a product.
  // If there is legible branding, search it and let the model name the printer from
  // real results. Only the short text query leaves the machine — never the image.
  let identifiedVia: PrinterIdSource = "vision";
  let searchQuery: string | undefined;
  let sources: WebSource[] | undefined;
  if (cfg.printer?.webLookup && visibleText) {
    try {
      searchQuery = `"${visibleText}" 3D printer`;
      onProgress?.(`Searching the web for “${visibleText}”…`);
      const results = await ddgSearch(searchQuery, {
        endpoint: cfg.printer.searchEndpoint,
        limit: cfg.printer.maxResults,
      });
      if (results.length) {
        sources = results;
        onProgress?.(`Identifying from ${results.length} search result(s)…`);
        const formFactor = `${kinematics}, ${enclosure}`;
        const looked = await ai.json<RawPrinterLookupJson>({
          system: PRINTER_LOOKUP_SYSTEM,
          prompt: printerLookupUserPrompt(visibleText, formFactor, results),
          images: [], // text-only grounding step
          schema: PRINTER_LOOKUP_SCHEMA as unknown as Record<string, unknown>,
          temperature: 0,
        });
        const lookedBrand = clean(looked.brand);
        const lookedModel = clean(looked.model);
        if (lookedBrand && !/^unknown$/i.test(lookedBrand)) {
          brand = lookedBrand;
          if (lookedModel && !/^unknown$/i.test(lookedModel)) model = lookedModel;
          identifiedVia = "web";
        }
      }
    } catch (e) {
      // Network/parse failure must not sink the whole detection — keep the vision guess.
      onProgress?.(`web lookup skipped: ${(e as Error).message}`);
    }
  }

  const summary = buildSummary(
    { kinematics, enclosure, brand, model, visibleText, confidence, identifiedVia },
    votes.length,
  );

  const result: PrinterDetectionResult = {
    id,
    ts,
    kinematics,
    enclosure,
    brand,
    model,
    visibleText,
    confidence,
    summary,
    votes,
    samples,
    snapshotPath,
    identifiedVia,
    searchQuery,
    sources,
  };
  store.addPrinterDetection(result);
  return result;
}

function normalizeKinematics(s: string): PrinterKinematics {
  const allowed: PrinterKinematics[] = ["bed_slinger", "corexy", "delta", "other", "unknown"];
  return (allowed as string[]).includes(s) ? (s as PrinterKinematics) : "unknown";
}

function normalizeEnclosure(s: string): Enclosure {
  const allowed: Enclosure[] = ["open", "enclosed", "unknown"];
  return (allowed as string[]).includes(s) ? (s as Enclosure) : "unknown";
}

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

/** Most frequent value; ties resolved by first-seen order. */
function mode(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestN = 0;
  for (const v of values) {
    const n = counts.get(v)!;
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

/** Pick the most common meaningful free-text answer, ignoring blanks/"unknown".
 *  Returns "unknown" if every pass abstained. Case-insensitive grouping, but the
 *  most frequent original spelling is returned. */
function bestText(values: string[]): string {
  const groups = new Map<string, { display: string; n: number }>();
  for (const raw of values) {
    const v = raw.trim();
    if (!v || /^(unknown|n\/?a|none|not visible|unclear)$/i.test(v)) continue;
    const key = v.toLowerCase();
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { display: v, n: 1 });
  }
  let best = "unknown";
  let bestN = 0;
  for (const { display, n } of groups.values()) {
    if (n > bestN) {
      bestN = n;
      best = display;
    }
  }
  return best;
}

function buildSummary(
  r: {
    kinematics: PrinterKinematics;
    enclosure: Enclosure;
    brand: string;
    model: string;
    visibleText: string;
    confidence: number;
    identifiedVia: PrinterIdSource;
  },
  passes: number,
): string {
  const kine: Record<PrinterKinematics, string> = {
    bed_slinger: "open-frame bed-slinger (i3-style)",
    corexy: "CoreXY (boxed gantry)",
    delta: "delta",
    other: "non-standard / other type",
    unknown: "unknown motion style",
  };
  const name =
    r.brand !== "unknown" && r.model !== "unknown"
      ? `${r.brand} ${r.model}`
      : r.brand !== "unknown"
        ? r.brand
        : "unidentified make";
  const encl = r.enclosure === "unknown" ? "" : `, ${r.enclosure}`;
  const seen = r.visibleText ? ` Visible branding: “${r.visibleText}”.` : "";
  const via =
    r.identifiedVia === "web"
      ? ` Identified via web search of the on-machine text.`
      : "";
  const pct = Math.round(r.confidence * 100);
  return `Looks like a ${kine[r.kinematics]}${encl} — ${r.identifiedVia === "web" ? "identified as" : "best guess:"} ${name}.${seen}${via} (${pct}% agreement on form factor across ${passes} pass${passes === 1 ? "" : "es"}).`;
}

function clamp01(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
