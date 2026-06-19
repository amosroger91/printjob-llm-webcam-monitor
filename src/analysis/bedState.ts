import { randomUUID } from "node:crypto";
import type { CaptureSource } from "../capture/index.js";
import type { VisionProvider } from "../ai/provider.js";
import { prepareImage } from "../image/preprocess.js";
import { BED_STATE_SCHEMA, BED_STATE_SYSTEM, bedStateUserPrompt, type RawBedStateJson } from "../ai/prompts.js";
import { store } from "../store/store.js";
import type { AppConfig, BedState, BedStateResult, BedStateVote } from "../types.js";

const OCCUPIED: BedState[] = ["printing", "complete", "failed"];

/**
 * Classify the current bed/job state (empty · printing · complete · failed).
 * Single frame, `samples` self-consistency passes, majority vote — the same
 * voting idea as the failure check but a coarser, standalone question. Confidence
 * is the share of (non-abstaining) votes the winning state received.
 */
export async function runBedStateCheck(
  source: CaptureSource,
  ai: VisionProvider,
  cfg: AppConfig,
  cameraId?: string,
  onProgress?: (msg: string) => void,
): Promise<BedStateResult> {
  const id = randomUUID().slice(0, 8);
  const ts = Date.now();
  const samples = Math.max(1, cfg.check.samples);

  onProgress?.("Capturing frame…");
  const raw = await source.grab();
  const prepped = await prepareImage(raw, cfg.image);
  const snapshotPath = await store.saveSnapshot(`${id}-bed`, prepped.bytes);

  const votes: BedStateVote[] = [];
  for (let s = 0; s < samples; s++) {
    onProgress?.(`Reading bed state, pass ${s + 1}/${samples}…`);
    try {
      const json = await ai.json<RawBedStateJson>({
        system: BED_STATE_SYSTEM,
        prompt: bedStateUserPrompt(),
        images: [prepped.base64],
        schema: BED_STATE_SCHEMA as unknown as Record<string, unknown>,
        temperature: samples > 1 ? cfg.check.sampleTemperature : 0,
      });
      votes.push({
        state: normalizeState(json.bed_state),
        bedVisible: json.bed_visible !== false,
        objectPresent: json.object_present === true,
        reasoning: (json.reasoning ?? "").trim(),
      });
    } catch (e) {
      onProgress?.(`pass error: ${(e as Error).message}`);
    }
  }
  if (votes.length === 0) throw new Error("all model passes failed for the bed-state check");

  // Majority signals from the decomposition.
  const bedVisible = votes.filter((v) => v.bedVisible).length >= votes.length / 2;
  const objectPresent = votes.filter((v) => v.objectPresent).length > votes.length / 2;

  let { state, confidence } = tally(votes);
  // Object clearly present but the state vote landed on "empty" → trust the object
  // signal and call it occupied (default to "complete" for an idle finished part).
  if (objectPresent && state === "empty") {
    const occupiedVote = votes.find((v) => OCCUPIED.includes(v.state))?.state;
    state = occupiedVote ?? "complete";
  } else if (!objectPresent && OCCUPIED.includes(state) && bedVisible) {
    // Conversely, nobody saw an object but the state says occupied → empty.
    state = "empty";
  }

  const occupied = OCCUPIED.includes(state);
  const summary = buildSummary(state, confidence, votes, bedVisible);

  const result: BedStateResult = { id, ts, cameraId, state, occupied, bedVisible, confidence, summary, votes, samples, snapshotPath };
  store.addBedState(result);
  return result;
}

function normalizeState(s: string): BedState {
  const allowed: BedState[] = ["empty", "printing", "complete", "failed", "unsure"];
  return (allowed as string[]).includes(s) ? (s as BedState) : "unsure";
}

/** Majority vote; "unsure" only wins if it is a strict majority so a single
 *  confident reading isn't drowned out by abstentions. */
function tally(votes: BedStateVote[]): { state: BedState; confidence: number } {
  const counts = new Map<BedState, number>();
  for (const v of votes) counts.set(v.state, (counts.get(v.state) ?? 0) + 1);

  const decisive = [...counts].filter(([s]) => s !== "unsure").sort((a, b) => b[1] - a[1]);
  const unsureCount = counts.get("unsure") ?? 0;

  if (decisive.length === 0) return { state: "unsure", confidence: clamp01(unsureCount / votes.length) };

  const [topState, topCount] = decisive[0];
  // Prefer a decisive state unless abstentions are the strict majority.
  if (unsureCount > votes.length / 2) return { state: "unsure", confidence: clamp01(unsureCount / votes.length) };
  return { state: topState, confidence: clamp01(topCount / votes.length) };
}

function buildSummary(state: BedState, confidence: number, votes: BedStateVote[], bedVisible: boolean): string {
  const pct = Math.round(confidence * 100);
  const note = votes.find((v) => v.state === state)?.reasoning;
  if (!bedVisible) {
    return `No print bed detected in the frame — check the camera is aimed at the printer. (${votes.length} pass${
      votes.length === 1 ? "" : "es"
    }).`;
  }
  const label: Record<BedState, string> = {
    empty: "Bed is empty and clean — ready for a new print",
    printing: "Print in progress on the bed",
    complete: "Finished print sitting on the bed — ready to remove",
    failed: "Failed print on the bed",
    unsure: "Bed state unclear from this frame",
  };
  return `${label[state]} (${pct}% agreement across ${votes.length} pass${votes.length === 1 ? "" : "es"}).${
    note ? ` ${note}` : ""
  }`;
}

function clamp01(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
