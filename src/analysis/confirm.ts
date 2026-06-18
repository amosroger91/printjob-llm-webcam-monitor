import type { AppConfig, Confirmation, IssueType, JurorVerdict } from "../types.js";
import type { VisionProvider } from "../ai/provider.js";
import { OllamaVisionProvider } from "../ai/ollama.js";
import {
  FAILURE_SCHEMA,
  FAILURE_SYSTEM,
  failureUserPrompt,
  type RawFailureJson,
} from "../ai/prompts.js";
import { rawToPass } from "./interpret.js";

/** Run one model's verdict on a frame: N passes, majority-voted. */
async function judge(
  ai: VisionProvider,
  base64: string,
  samples: number,
  temperature: number,
): Promise<{ failed: boolean; confidence: number; issues: IssueType[]; note: string }> {
  let failVotes = 0;
  let confSum = 0;
  let votes = 0;
  const issues = new Set<IssueType>();
  let note = "";
  for (let s = 0; s < samples; s++) {
    const raw = await ai.json<RawFailureJson>({
      system: FAILURE_SYSTEM,
      prompt: failureUserPrompt(),
      images: [base64],
      schema: FAILURE_SCHEMA as unknown as Record<string, unknown>,
      temperature: samples > 1 ? temperature : 0,
    });
    const pass = rawToPass(raw);
    votes++;
    if (pass.failed) failVotes++;
    confSum += pass.confidence;
    for (const i of pass.issues) issues.add(i.type);
    note = pass.reasoning;
  }
  const failed = failVotes > votes / 2;
  return { failed, confidence: votes ? confSum / votes : 0, issues: [...issues], note };
}

async function askJuror(model: string, base64: string, cfg: AppConfig): Promise<JurorVerdict> {
  const ai = new OllamaVisionProvider({ ...cfg.ai, model });
  const health = await ai.health();
  if (!health.ok) {
    return { model, verdict: "error", confidence: 0, issues: [], note: health.detail };
  }
  try {
    const r = await judge(ai, base64, cfg.confirm.samplesPerJuror, cfg.check.sampleTemperature);
    return {
      model,
      verdict: r.failed ? "failed" : "ok",
      confidence: r.confidence,
      issues: r.issues,
      note: r.note,
    };
  } catch (e) {
    return { model, verdict: "error", confidence: 0, issues: [], note: (e as Error).message };
  }
}

/**
 * Consult the jury on a suspected failure. The primary model's own verdict is the
 * first juror; the configured second-opinion models vote in parallel. "confirmed"
 * means a strict majority of the models that answered agree it has failed.
 */
export async function runConfirmation(
  base64: string,
  cfg: AppConfig,
  primary: JurorVerdict,
  onProgress?: (msg: string) => void,
): Promise<Confirmation> {
  const others = cfg.confirm.models.filter((m) => m && m !== cfg.ai.model);
  onProgress?.(`Getting a second opinion from: ${others.join(", ") || "(none configured)"}…`);

  const extra = await Promise.all(
    others.map(async (m) => {
      const v = await askJuror(m, base64, cfg);
      onProgress?.(`${m}: ${v.verdict}${v.issues.length ? " (" + v.issues.join(",") + ")" : ""}`);
      return v;
    }),
  );

  const jury = [primary, ...extra];
  const valid = jury.filter((j) => j.verdict === "failed" || j.verdict === "ok");
  const failedVotes = valid.filter((j) => j.verdict === "failed").length;
  const totalVotes = valid.length;
  const confirmed = totalVotes > 0 && failedVotes / totalVotes > 0.5;
  return { triggered: true, jury, failedVotes, totalVotes, confirmed };
}

/** Whether any usable second opinion exists (otherwise the jury is just the primary). */
export function hasSecondOpinion(cfg: AppConfig): boolean {
  return cfg.confirm.enabled && cfg.confirm.models.some((m) => m && m !== cfg.ai.model);
}
