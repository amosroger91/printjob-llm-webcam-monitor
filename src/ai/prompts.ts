// Prompts and JSON schemas tuned for SMALL local vision models (e.g. gemma3:4b).
// Principles baked in here:
//   - fixed boolean keys instead of free-form arrays (small models fill fixed
//     slots far more reliably than they invent well-formed object arrays)
//   - each known failure mode gets its own slot => forces explicit consideration
//     (the benefit of decomposition without N separate model calls)
//   - concrete visual definitions so the model knows what each term looks like
//   - explicit "if unsure, say so with low confidence" to curb false alarms

export const FAILURE_SYSTEM = `You are a meticulous 3D-printing inspector looking at one webcam photo of a printer mid-print.
Your job is to describe the state of the print honestly. Report only what is clearly visible;
shadows, reflections, the moving nozzle, and stray light are NOT defects.
Answer ONLY with the requested JSON. No prose.`;

// Vivid, contrastive definitions. Small models do best when each option is described by
// what it LOOKS like and how it differs from a clean print.
const FAILURE_MODES = `Decide the overall state of the print:
- "clean": a solid object growing layer by layer on the bed. It may be large, dark, intricate, or have many small parts printing at once — that is still clean as long as each part is a solid shape, not a loose tangle.
- "minor": mostly fine, but small cosmetic defects (a few fine hairs/whiskers, slight roughness).
- "failing": something is clearly wrong. Tell-tale signs:
    * spaghetti: a chaotic bird's-nest of loose, thin plastic strands going in random directions, piled up or waving in the air and NOT forming a solid object. This is plastic filament, the same color as the print.
    * detached: the object has come off the bed, shifted off its base, or is being dragged around.
    * blob: a large lump/glob of melted plastic stuck on the print or nozzle.
    * stringing: many fine plastic threads stretched across or around the print.
    * layer_shift: layers abruptly offset sideways so the object looks sheared.
- "unsure": the image is too dark, blurry, or ambiguous to tell.

IMPORTANT — these are NOT failures:
- The printer's own hardware: wires, cables, ribbon cables, drive belts, gears, threaded rods, the metal frame, hoses, and the nozzle/hotend. These are not filament. Never call machine wiring "spaghetti" or "stringing".
- A normal solid print, even if it is complex, dark, or made of many separate small parts on the bed.
- A thin, sparse, or translucent first layer just starting on the bed.
Only call it spaghetti when you see loose plastic strands that clearly are NOT part of the machine and do NOT form a solid object.`;

export function failureUserPrompt(): string {
  return `Inspect this photo of a 3D print in progress.
${FAILURE_MODES}

Report the overall print_state, the single most prominent issue (primary_issue, or "none"),
how certain you are, and one short sentence describing what you see.`;
}

// Categorical fields only — a 4B model produces these far more reliably than a float
// confidence (which it tends to peg at 0) or a holistic true/false "failed" judgment.
export const FAILURE_SCHEMA = {
  type: "object",
  properties: {
    print_state: { type: "string", enum: ["clean", "minor", "failing", "unsure"] },
    primary_issue: {
      type: "string",
      enum: ["none", "spaghetti", "detached", "blob", "stringing", "layer_shift", "other"],
    },
    certainty: { type: "string", enum: ["low", "medium", "high"] },
    reasoning: { type: "string" },
  },
  required: ["print_state", "primary_issue", "certainty", "reasoning"],
} as const;

export interface RawFailureJson {
  print_state: "clean" | "minor" | "failing" | "unsure";
  primary_issue: "none" | "spaghetti" | "detached" | "blob" | "stringing" | "layer_shift" | "other";
  certainty: "low" | "medium" | "high";
  reasoning: string;
}

// ---- Bed / job state (use case 3) ----
// A coarse "what is the printer doing?" classifier, separate from the fine-grained
// failure check. Same small-model principles: vivid contrastive definitions, a fixed
// enum, and an explicit "unsure" escape hatch instead of forcing a guess.

export const BED_STATE_SYSTEM = `You are inspecting one webcam photo of a 3D printer to report the state of the print bed (the flat plate the printer builds on).
Report only what is clearly visible. The machine's own frame, gantry, nozzle, wires, and screen are NOT objects on the bed.
Answer ONLY with the requested JSON. No prose.`;

const BED_STATES = `Classify the bed into exactly one state:
- "empty": the build plate is clear and clean — no printed object on it. The printer is idle or ready for a new job. A bare textured/glass/PEI plate with nothing on it is "empty".
- "printing": a partially-built object is on the plate AND the print is clearly still in progress — e.g. the nozzle/toolhead is down near the object, mid-build, only some layers done.
- "complete": a finished, intact printed object is sitting on the plate and the toolhead is parked away / lifted — the job looks done and the part is ready to remove.
- "failed": the plate is occupied by a clearly bad result — a tangled spaghetti mess, a print that detached and is loose/knocked over, or a blob — rather than a clean solid object.
- "unsure": the image is too dark, blurry, or obstructed to tell.

Guidance:
- "empty" vs "complete": empty = nothing on the plate; complete = a solid finished object is resting on it.
- "printing" vs "complete": printing = toolhead engaged, build unfinished; complete = toolhead parked, object whole.
- "complete" vs "failed": complete = one solid intact object; failed = loose strands, a tangle, or a detached/toppled mess.
- Do not count the printer's frame, gantry rails, nozzle, cables, or a control screen as objects on the bed.`;

export function bedStateUserPrompt(): string {
  return `Look at this 3D printer photo and report the state of the build plate.
${BED_STATES}

Report the single best bed_state and one short sentence describing what you see on the plate.`;
}

export const BED_STATE_SCHEMA = {
  type: "object",
  properties: {
    bed_state: { type: "string", enum: ["empty", "printing", "complete", "failed", "unsure"] },
    reasoning: { type: "string" },
  },
  required: ["bed_state", "reasoning"],
} as const;

export interface RawBedStateJson {
  bed_state: "empty" | "printing" | "complete" | "failed" | "unsure";
  reasoning: string;
}

// ---- Printer identification (use case 4) ----
// "What machine am I looking at?" Coarse, reliable structural fields plus a
// best-effort make/model read from any visible branding. Small models are weak at
// naming exact models, so we ask them to FIRST report any legible text/logo and
// only then guess — and to say "unknown" rather than invent.

export const PRINTER_SYSTEM = `You identify 3D printers from a single webcam photo.
Be honest about uncertainty: read any branding/text actually visible on the machine, judge its overall form, and only then guess the make/model.
If you cannot read a brand or are unsure, say "unknown" — do NOT invent a name.
Answer ONLY with the requested JSON. No prose.`;

const PRINTER_GUIDE = `Report these fields about the printer in view:
- kinematics — the motion style:
    * "bed_slinger": an open i3-style frame where the print bed slides back and forth (Y axis) under a gantry. Most common hobby FDM layout.
    * "corexy": a boxy/cube frame (often enclosed) where the toolhead moves in X and Y near the top and the bed only drops in Z.
    * "delta": a tall cylindrical/triangular frame with three diagonal arms meeting at one print head.
    * "other": a clearly different machine (e.g. resin/SLA with a vat, belt printer).
    * "unknown": you can't tell the motion style from this view.
- enclosure — "enclosed" if the build area is boxed in by panels/doors/walls, "open" if the frame is exposed, else "unknown".
- visible_text — transcribe any brand name, model name, or logo text you can actually READ on the machine (e.g. on the toolhead, frame, or screen). If none is legible, use "".
- brand — the manufacturer if you can identify it from the text or distinctive design, else "unknown".
- model — the specific model if identifiable, else "unknown".

Base brand/model on what you can actually see. A confident "unknown" is better than a wrong guess.`;

export function printerUserPrompt(): string {
  return `Identify the 3D printer in this photo.
${PRINTER_GUIDE}

Give your single best reading plus one short sentence on what features led to it.`;
}

export const PRINTER_SCHEMA = {
  type: "object",
  properties: {
    kinematics: { type: "string", enum: ["bed_slinger", "corexy", "delta", "other", "unknown"] },
    enclosure: { type: "string", enum: ["open", "enclosed", "unknown"] },
    visible_text: { type: "string" },
    brand: { type: "string" },
    model: { type: "string" },
    reasoning: { type: "string" },
  },
  required: ["kinematics", "enclosure", "visible_text", "brand", "model", "reasoning"],
} as const;

export interface RawPrinterJson {
  kinematics: "bed_slinger" | "corexy" | "delta" | "other" | "unknown";
  enclosure: "open" | "enclosed" | "unknown";
  visible_text: string;
  brand: string;
  model: string;
  reasoning: string;
}

// ---- Printer lookup from web search (grounds make/model in real results) ----
// A text-only call: the vision model can READ the branding but doesn't KNOW which
// machine it belongs to. We search that text on the web and let the model name the
// printer FROM the results, not from memory — so "ACE GEN2" resolves to the Anycubic
// that actually ships it instead of a hallucinated name.

export const PRINTER_LOOKUP_SYSTEM = `You identify a 3D printer's manufacturer and model from web search results.
Use ONLY the provided search results as evidence — do not rely on prior memory.
If the results clearly point to one make/model, name it. If they conflict or don't say, use "unknown".
Answer ONLY with the requested JSON. No prose.`;

export function printerLookupUserPrompt(
  visibleText: string,
  formFactor: string,
  results: { title: string; snippet: string }[],
): string {
  const blocks = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`)
    .join("\n\n");
  return `Text/branding read off a 3D printer: "${visibleText}".
Observed form factor: ${formFactor}.

Web search results for that text:
${blocks}

From these results, identify the printer's manufacturer (brand) and the specific model it belongs to.
The branding may be a sub-component or technology name (e.g. a multicolor system) rather than the model itself — in that case report the manufacturer and the printer model that ships with it.
Use "unknown" for anything the results don't support.`;
}

export const PRINTER_LOOKUP_SCHEMA = {
  type: "object",
  properties: {
    brand: { type: "string" },
    model: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    reasoning: { type: "string" },
  },
  required: ["brand", "model", "confidence", "reasoning"],
} as const;

export interface RawPrinterLookupJson {
  brand: string;
  model: string;
  confidence: "low" | "medium" | "high";
  reasoning: string;
}

// ---- Troubleshooting (use case 2) ----

export const TROUBLESHOOT_SYSTEM = `You are an expert 3D-printing troubleshooter helping diagnose a failed or failing print from a webcam photo and a description of the symptom.
You propose concrete, testable changes (slicer settings, hardware, filament) and state exactly what a successful outcome would LOOK like in a later photo, so the change can be visually verified.
Be specific and practical. Answer ONLY with the requested JSON.`;

export function troubleshootUserPrompt(symptom: string): string {
  return `The user reports this problem with the print shown: "${symptom}".
Diagnose the most likely causes and propose up to 3 concrete changes, ordered most-likely-to-help first.
For each: a one-line hypothesis, the exact change to make, the expected outcome, and the visual signal to watch for in a later photo to confirm it worked.`;
}

export const TROUBLESHOOT_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          hypothesis: { type: "string" },
          change: { type: "string" },
          expectedOutcome: { type: "string" },
          watchFor: { type: "string" },
        },
        required: ["hypothesis", "change", "expectedOutcome", "watchFor"],
      },
    },
  },
  required: ["suggestions"],
} as const;

// ---- Verification (did the change help?) ----

export const VERIFY_SYSTEM = `You compare two webcam photos of a 3D print: BEFORE (left) and AFTER (right) a change was applied.
You judge whether the specific problem improved. Be objective; ignore lighting/angle differences.
Answer ONLY with the requested JSON.`;

export function verifyUserPrompt(symptom: string, watchFor: string): string {
  return `Original problem: "${symptom}".
We applied a change and are checking the result. Success looks like: "${watchFor}".
The image shows BEFORE on the left and AFTER on the right. Did the problem improve?`;
}

export const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["improved", "no_change", "worse", "unclear"] },
    confidence: { type: "number" },
    note: { type: "string" },
  },
  required: ["verdict", "confidence", "note"],
} as const;

export interface RawVerifyJson {
  verdict: "improved" | "no_change" | "worse" | "unclear";
  confidence: number;
  note: string;
}
