import type { RawFailureJson } from "../ai/prompts.js";
import type { IssueFinding, IssueType, SinglePass } from "../types.js";

// Catastrophic modes mean the print has failed even if the model under-rates the overall
// state. Stringing/other on their own are treated as minor unless the model says "failing".
const CATASTROPHIC: IssueType[] = ["spaghetti", "detached", "blob", "layer_shift"];
const CERTAINTY_CONF: Record<RawFailureJson["certainty"], number> = { low: 0.4, medium: 0.65, high: 0.9 };

export function clamp01(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Map the model's categorical report to a verdict. The baseline eval showed the model's
 * own holistic judgment is unreliable, but its anomaly detection is strong — so we derive
 * "failed" from the detected issue + state rather than trusting a single boolean.
 * Shared by the primary check, the jury, and the eval so all interpret identically.
 */
export function rawToPass(raw: RawFailureJson): SinglePass {
  const issue = raw.primary_issue;
  const stateFailing = raw.print_state === "failing";
  const failed = stateFailing || CATASTROPHIC.includes(issue as IssueType);

  let confidence = CERTAINTY_CONF[raw.certainty] ?? 0.4;
  if (raw.print_state === "unsure") confidence = Math.min(confidence, 0.3);

  const issues: IssueFinding[] = [];
  if (issue && issue !== "none") {
    issues.push({
      type: issue as IssueType,
      present: true,
      severity: failed ? "major" : "minor",
      note: raw.reasoning ?? "",
    });
  }
  return { failed, confidence: clamp01(confidence), issues, reasoning: raw.reasoning ?? "" };
}
