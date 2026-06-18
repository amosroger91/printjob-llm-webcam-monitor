// Accuracy harness: runs the real failure-detection path (preprocess -> model ->
// structured JSON) over the labeled fixture set and prints a confusion matrix.
// Use it to establish a baseline and to measure the effect of prompt/preprocess
// changes. Single pass by default; set PW_EVAL_SAMPLES>1 to test the vote.
//
//   npm run eval                # 1 pass/image
//   PW_EVAL_SAMPLES=3 npm run eval
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../src/config.js";
import { prepareImage } from "../src/image/preprocess.js";
import { OllamaVisionProvider } from "../src/ai/ollama.js";
import { FAILURE_SCHEMA, FAILURE_SYSTEM, failureUserPrompt, type RawFailureJson } from "../src/ai/prompts.js";
import { rawToPass } from "../src/analysis/interpret.js";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = Number(process.env.PW_EVAL_SAMPLES ?? 1);
// Single sample is deterministic; multi-sample votes need variation to be meaningful.
const TEMP = SAMPLES > 1 ? config.check.sampleTemperature : 0;

interface Fixture { file: string; label: "failed" | "healthy"; type: string; url: string }
const manifest = JSON.parse(readFileSync(join(here, "fixtures.json"), "utf8")) as { fixtures: Fixture[] };

const ai = new OllamaVisionProvider(config.ai);
const health = await ai.health();
if (!health.ok) {
  console.error(`model not ready: ${health.detail}`);
  process.exit(1);
}
console.log(`\neval: model=${config.ai.model}  samples/image=${SAMPLES}  temp=${TEMP}  maxSize=${config.image.maxSize}\n`);

interface Row {
  file: string;
  actual: string;
  predicted: string;
  failVotes: number;
  conf: number;
  issues: string[];
  correct: boolean;
  ms: number;
}
const rows: Row[] = [];

for (const fx of manifest.fixtures) {
  const path = join(here, "fixtures", fx.label, fx.file);
  if (!existsSync(path)) {
    console.log(`  (missing, run npm run fetch-fixtures) ${fx.label}/${fx.file}`);
    continue;
  }
  const prepped = await prepareImage(readFileSync(path), config.image);
  let failVotes = 0;
  let confSum = 0;
  let votes = 0;
  const issueSet = new Set<string>();
  const t0 = Date.now();
  for (let s = 0; s < SAMPLES; s++) {
    try {
      const r = await ai.json<RawFailureJson>({
        system: FAILURE_SYSTEM,
        prompt: failureUserPrompt(),
        images: [prepped.base64],
        schema: FAILURE_SCHEMA as unknown as Record<string, unknown>,
        temperature: TEMP,
      });
      const pass = rawToPass(r);
      votes++;
      if (pass.failed) failVotes++;
      confSum += pass.confidence;
      for (const iss of pass.issues) issueSet.add(iss.type);
    } catch (e) {
      console.log(`    pass error on ${fx.file}: ${(e as Error).message}`);
    }
  }
  const predicted = votes > 0 && failVotes > votes / 2 ? "failed" : "healthy";
  const correct = predicted === fx.label;
  const row: Row = {
    file: fx.file,
    actual: fx.label,
    predicted,
    failVotes,
    conf: votes ? confSum / votes : 0,
    issues: [...issueSet],
    correct,
    ms: Date.now() - t0,
  };
  rows.push(row);
  const mark = correct ? "OK  " : "WRONG";
  console.log(
    `  ${mark} ${fx.file.padEnd(24)} actual=${fx.actual ?? fx.label} pred=${predicted.padEnd(7)} votes=${failVotes}/${votes} conf=${row.conf.toFixed(2)} [${row.issues.join(",")}]`,
  );
}

// Confusion matrix (positive class = "failed")
const tp = rows.filter((r) => r.actual === "failed" && r.predicted === "failed").length;
const fn = rows.filter((r) => r.actual === "failed" && r.predicted === "healthy").length;
const fp = rows.filter((r) => r.actual === "healthy" && r.predicted === "failed").length;
const tn = rows.filter((r) => r.actual === "healthy" && r.predicted === "healthy").length;
const n = rows.length;
const acc = n ? (tp + tn) / n : 0;
const precision = tp + fp ? tp / (tp + fp) : 0;
const recall = tp + fn ? tp / (tp + fn) : 0;
const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

console.log(`\n  confusion matrix (positive = failed):`);
console.log(`                 pred failed   pred healthy`);
console.log(`   act failed        ${String(tp).padStart(3)}           ${String(fn).padStart(3)}   (recall ${(recall * 100).toFixed(0)}%)`);
console.log(`   act healthy       ${String(fp).padStart(3)}           ${String(tn).padStart(3)}   (fall-out ${fp + tn ? ((fp / (fp + tn)) * 100).toFixed(0) : 0}%)`);
console.log(`\n  accuracy ${(acc * 100).toFixed(1)}%   precision ${(precision * 100).toFixed(0)}%   recall ${(recall * 100).toFixed(0)}%   F1 ${(f1 * 100).toFixed(0)}%   (n=${n})`);

const out = { ts: Date.now(), model: config.ai.model, samples: SAMPLES, maxSize: config.image.maxSize, acc, precision, recall, f1, tp, fn, fp, tn, rows };
writeFileSync(join(here, "eval-results.json"), JSON.stringify(out, null, 2));
console.log(`\n  wrote test/eval-results.json`);
