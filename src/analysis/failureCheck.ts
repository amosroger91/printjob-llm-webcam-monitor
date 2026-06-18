import { randomUUID } from "node:crypto";
import type { CaptureSource } from "../capture/index.js";
import type { VisionProvider } from "../ai/provider.js";
import { prepareImage } from "../image/preprocess.js";
import {
  FAILURE_SCHEMA,
  FAILURE_SYSTEM,
  failureUserPrompt,
  type RawFailureJson,
} from "../ai/prompts.js";
import { store } from "../store/store.js";
import { rawToPass, clamp01 } from "./interpret.js";
import { runConfirmation, hasSecondOpinion } from "./confirm.js";
import type {
  AppConfig,
  CheckResult,
  Confirmation,
  IssueFinding,
  IssueType,
  JurorVerdict,
  SinglePass,
} from "../types.js";

export { rawToPass } from "./interpret.js";

/** Majority vote of samples within one frame. */
function fuseFrame(passes: SinglePass[]): { failed: boolean; confidence: number; issueCounts: Map<IssueType, number> } {
  const failVotes = passes.filter((p) => p.failed).length;
  const failed = failVotes > passes.length / 2;
  const avgConf = passes.reduce((s, p) => s + p.confidence, 0) / passes.length;
  // Confidence reflects vote agreement too: unanimous => keep model conf; split => discount.
  const agreement = Math.max(failVotes, passes.length - failVotes) / passes.length;
  const confidence = clamp01(avgConf * agreement);
  const issueCounts = new Map<IssueType, number>();
  for (const p of passes) {
    if (!p.failed) continue;
    for (const i of p.issues) issueCounts.set(i.type, (issueCounts.get(i.type) ?? 0) + 1);
  }
  return { failed, confidence, issueCounts };
}

/**
 * Run a full double-checked failure inspection:
 *  1. capture `frames` frames spaced `frameDelayMs` apart (cross-frame check)
 *  2. run `samples` model passes per frame (self-consistency vote)
 *  3. a frame counts as "failed" only by sample majority
 *  4. overall verdict requires a majority of FRAMES to fail (transients rejected)
 *  5. low aggregate confidence => verdict "uncertain" (candidate for escalation)
 */
export async function runFailureCheck(
  source: CaptureSource,
  ai: VisionProvider,
  cfg: AppConfig,
  onProgress?: (msg: string) => void,
): Promise<CheckResult> {
  const id = randomUUID().slice(0, 8);
  const ts = Date.now();
  const { samples, frames, frameDelayMs, confidenceThreshold } = cfg.check;

  const allPasses: SinglePass[] = [];
  const snapshotPaths: string[] = [];
  const frameResults: ReturnType<typeof fuseFrame>[] = [];
  let lastFrameBase64 = "";

  for (let f = 0; f < frames; f++) {
    onProgress?.(`Capturing frame ${f + 1}/${frames}…`);
    const raw = await source.grab();
    const prepped = await prepareImage(raw, cfg.image);
    lastFrameBase64 = prepped.base64;
    snapshotPaths.push(await store.saveSnapshot(`${id}-f${f}`, prepped.bytes));

    const framePasses: SinglePass[] = [];
    for (let s = 0; s < samples; s++) {
      onProgress?.(`Analyzing frame ${f + 1}, pass ${s + 1}/${samples}…`);
      try {
        const json = await ai.json<RawFailureJson>({
          system: FAILURE_SYSTEM,
          prompt: failureUserPrompt(),
          images: [prepped.base64],
          schema: FAILURE_SCHEMA as unknown as Record<string, unknown>,
          // Deterministic for a single sample; vary samples so the vote is meaningful.
          temperature: samples > 1 ? cfg.check.sampleTemperature : 0,
        });
        framePasses.push(rawToPass(json));
      } catch (e) {
        // A failed pass abstains rather than poisoning the vote.
        onProgress?.(`pass error: ${(e as Error).message}`);
      }
    }
    if (framePasses.length === 0) throw new Error("all model passes failed for this frame");
    allPasses.push(...framePasses);
    frameResults.push(fuseFrame(framePasses));

    if (f < frames - 1) await sleep(frameDelayMs);
  }

  // Cross-frame fusion: real failures persist across frames.
  const failedFrames = frameResults.filter((r) => r.failed).length;
  const overallFailed = failedFrames > frames / 2;
  let confidence = aggregateConfidence(frameResults, overallFailed);

  // Issues: surface a type if it was flagged in a majority of failed frames.
  const issues = aggregateIssues(frameResults, samples);

  let verdict: CheckResult["verdict"];
  if (confidence < confidenceThreshold) verdict = "uncertain";
  else verdict = overallFailed ? "failed" : "ok";

  // Second-opinion jury: only when a failure is suspected (failed or uncertain) and
  // other models are available. Diverse models confirm true failures and veto false
  // alarms — corroboration -> failed; disagreement -> downgrade to uncertain.
  let confirmation: Confirmation | undefined;
  const suspected = overallFailed || verdict === "uncertain";
  if (suspected && hasSecondOpinion(cfg)) {
    const primaryJuror: JurorVerdict = {
      model: ai.name,
      verdict: overallFailed ? "failed" : "unsure",
      confidence,
      issues: issues.map((i) => i.type),
      note: issues.map((i) => i.type).join(", "),
    };
    confirmation = await runConfirmation(lastFrameBase64, cfg, primaryJuror, onProgress);
    if (confirmation.confirmed) {
      verdict = "failed";
      confidence = Math.max(confidence, confirmation.failedVotes / confirmation.totalVotes);
    } else {
      // The jury did not corroborate the primary — flag for a human rather than alarm.
      verdict = "uncertain";
    }
  }

  const summary = buildSummary(verdict, issues, failedFrames, frames, confidence, confirmation);

  const result: CheckResult = {
    id,
    ts,
    verdict,
    confidence,
    issues,
    summary,
    framesAnalyzed: frames,
    samplesPerFrame: samples,
    passes: allPasses,
    snapshotPaths,
    confirmation,
  };
  store.addCheck(result);
  return result;
}

function aggregateConfidence(frameResults: ReturnType<typeof fuseFrame>[], overallFailed: boolean): number {
  // Average the confidence of the frames that agree with the overall verdict.
  const agreeing = frameResults.filter((r) => r.failed === overallFailed);
  if (agreeing.length === 0) return 0;
  const base = agreeing.reduce((s, r) => s + r.confidence, 0) / agreeing.length;
  // Scale by how many frames agreed (cross-frame consistency).
  const consistency = agreeing.length / frameResults.length;
  return clamp01(base * consistency);
}

function aggregateIssues(frameResults: ReturnType<typeof fuseFrame>[], samples: number): IssueFinding[] {
  const totals = new Map<IssueType, number>();
  const failedFrames = frameResults.filter((r) => r.failed);
  for (const fr of failedFrames) {
    for (const [type, count] of fr.issueCounts) {
      // weight by within-frame agreement
      totals.set(type, (totals.get(type) ?? 0) + count / samples);
    }
  }
  const out: IssueFinding[] = [];
  for (const [type, score] of totals) {
    if (score >= Math.max(1, failedFrames.length) / 2) {
      out.push({ type, present: true, severity: score >= failedFrames.length ? "major" : "minor", note: "" });
    }
  }
  return out.sort((a, b) => (a.severity === "major" ? -1 : 1));
}

function buildSummary(
  verdict: CheckResult["verdict"],
  issues: IssueFinding[],
  failedFrames: number,
  frames: number,
  confidence: number,
  confirmation?: Confirmation,
): string {
  const pct = Math.round(confidence * 100);
  const jury = confirmation
    ? ` Jury ${confirmation.failedVotes}/${confirmation.totalVotes} agreed it failed (${confirmation.jury
        .map((j) => `${shortModel(j.model)}:${j.verdict}`)
        .join(", ")}).`
    : "";
  if (verdict === "ok") return `Print looks healthy across ${frames} frame(s). Confidence ${pct}%.`;
  if (verdict === "uncertain")
    return `Possible problem but not certain (${failedFrames}/${frames} frames, ${pct}% confidence).${jury} Worth a human glance${issues.length ? `: ${issues.map((i) => i.type).join(", ")}` : ""}.`;
  const list = issues.length ? issues.map((i) => `${i.type} (${i.severity})`).join(", ") : "an unspecified problem";
  return `Likely FAILURE: ${list}. Seen in ${failedFrames}/${frames} frames, ${pct}% confidence.${jury}`;
}

const shortModel = (m: string) => m.replace(/^ollama:/, "").split(":")[0];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
