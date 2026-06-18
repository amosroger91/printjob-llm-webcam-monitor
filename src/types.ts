// Shared types for print-watch.

export interface CameraConfig {
  type: "http-snapshot" | "mjpeg" | "usb" | "folder";
  url?: string;
  usbDevice?: string;
  folderPath?: string;
  /** Absolute path to the ffmpeg binary for `usb` capture. Optional — defaults to
   *  "ffmpeg" on PATH. Set this when ffmpeg is installed but not yet on the PATH
   *  (e.g. a fresh winget install before the shell is restarted). */
  ffmpegPath?: string;
}

export interface ImageConfig {
  maxSize: number;
  /** [left, top, width, height] in pixels of the ORIGINAL frame, or null for full frame. */
  crop: [number, number, number, number] | null;
  normalize: boolean;
  grayscale: boolean;
}

export interface AiConfig {
  provider: "ollama";
  baseUrl: string;
  model: string;
  temperature: number;
  numCtx: number;
}

export interface CheckConfig {
  samples: number;
  frames: number;
  frameDelayMs: number;
  confidenceThreshold: number;
  /** Temperature for self-consistency samples. >0 so repeated passes vary and the
   *  majority vote is meaningful; a single sample always runs deterministically at 0. */
  sampleTemperature: number;
}

/** Second-opinion jury: when the primary model suspects a failure, these other
 *  local models vote to confirm it. Diverse models make uncorrelated mistakes,
 *  so corroboration is strong evidence and disagreement flags a false alarm. */
export interface ConfirmConfig {
  enabled: boolean;
  /** Additional vision models (besides ai.model) to consult on a suspected failure. */
  models: string[];
  /** Passes each juror runs (majority-voted per juror). */
  samplesPerJuror: number;
}

/** Printer-detection options. Web lookup sends ONLY the short text read off the
 *  machine (never the image) to a search engine to pin down the make/model. */
export interface PrinterConfig {
  /** Look the on-machine text up online to identify brand/model. Off => vision-only. */
  webLookup: boolean;
  /** DuckDuckGo HTML endpoint; override only if proxying. */
  searchEndpoint: string;
  /** How many search results to feed the model / keep as sources. */
  maxResults: number;
}

export interface AppConfig {
  server: { port: number; host: string };
  camera: CameraConfig;
  image: ImageConfig;
  ai: AiConfig;
  check: CheckConfig;
  confirm: ConfirmConfig;
  printer: PrinterConfig;
}

/** One model's vote in the confirmation jury. */
export interface JurorVerdict {
  model: string;
  verdict: "failed" | "ok" | "unsure" | "error";
  confidence: number;
  issues: IssueType[];
  note: string;
}

/** Outcome of consulting the jury on a suspected failure. */
export interface Confirmation {
  triggered: boolean;
  jury: JurorVerdict[];
  failedVotes: number;
  totalVotes: number;
  confirmed: boolean;
}

/** The catalogue of failure modes we ask the model about, one narrow question each. */
export type IssueType =
  | "spaghetti"
  | "detached"
  | "blob"
  | "stringing"
  | "layer_shift"
  | "other";

export interface IssueFinding {
  type: IssueType;
  present: boolean;
  severity: "none" | "minor" | "major";
  note: string;
}

/** Result of a single model pass on a single image. */
export interface SinglePass {
  failed: boolean;
  confidence: number; // 0..1
  issues: IssueFinding[];
  reasoning: string;
}

/** Aggregated result after self-consistency voting + cross-frame fusion. */
export interface CheckResult {
  id: string;
  ts: number;
  verdict: "ok" | "failed" | "uncertain";
  confidence: number;
  issues: IssueFinding[];
  summary: string;
  // bookkeeping for transparency / the double-check UI
  framesAnalyzed: number;
  samplesPerFrame: number;
  passes: SinglePass[];
  snapshotPaths: string[];
  /** Present when the jury was consulted (i.e. a failure was suspected). */
  confirmation?: Confirmation;
}

/**
 * Bed / job state, independent of the failure check. Answers "what is the printer
 * doing right now?" rather than "is the in-progress print spaghetti?".
 *  - empty:    bed is clear and clean, ready for a new job (nothing on the plate)
 *  - printing: an object is on the bed and the print is actively in progress
 *  - complete: a finished print is sitting on the bed, ready to be removed
 *  - failed:   the bed is occupied by a failed/detached/spaghetti mess
 *  - unsure:   too dark/blurry/ambiguous to classify
 */
export type BedState = "empty" | "printing" | "complete" | "failed" | "unsure";

/** One model pass's vote on the bed state. */
export interface BedStateVote {
  state: BedState;
  reasoning: string;
}

/** Aggregated bed-state classification after self-consistency voting. */
export interface BedStateResult {
  id: string;
  ts: number;
  state: BedState;
  /** Convenience: whether anything is on the bed (printing | complete | failed). */
  occupied: boolean;
  confidence: number; // 0..1
  summary: string;
  votes: BedStateVote[];
  samples: number;
  snapshotPath: string;
}

/**
 * Printer identification from the webcam view. Exact make/model is a best-effort
 * guess (small models read visible logos/text and infer form factor); the coarse
 * structural fields (kinematics, enclosure) are far more reliable than brand/model.
 *  - bed_slinger: i3-style, the bed moves back/forth on the Y axis (open frame, gantry over a sliding bed)
 *  - corexy:      boxy/cube frame, the toolhead moves in X/Y up top, bed only moves down in Z
 *  - delta:       tall cylindrical frame with three diagonal arms to one effector
 *  - other:       a recognizable printer that fits none of the above (SLA/resin, belt, etc.)
 *  - unknown:     can't tell from the image
 */
export type PrinterKinematics = "bed_slinger" | "corexy" | "delta" | "other" | "unknown";
export type Enclosure = "open" | "enclosed" | "unknown";

/** One model pass's attempt to identify the printer. */
export interface PrinterDetectionVote {
  kinematics: PrinterKinematics;
  enclosure: Enclosure;
  brand: string; // best-guess manufacturer, or "unknown"
  model: string; // best-guess model, or "unknown"
  visibleText: string; // any logo/branding text actually legible in the frame, or ""
  reasoning: string;
}

/** A single web search result kept as provenance for a web-grounded identification. */
export interface WebSource {
  title: string;
  url: string;
  snippet: string;
}

/** How the final brand/model was determined. */
export type PrinterIdSource = "vision" | "web";

/** Aggregated printer identification after self-consistency voting (+ optional web lookup). */
export interface PrinterDetectionResult {
  id: string;
  ts: number;
  kinematics: PrinterKinematics;
  enclosure: Enclosure;
  brand: string;
  model: string;
  visibleText: string;
  /** Agreement on the kinematics field across passes (0..1) — the headline reliability signal. */
  confidence: number;
  summary: string;
  votes: PrinterDetectionVote[];
  samples: number;
  snapshotPath: string;
  /** "web" when the on-machine text was looked up online to pin down brand/model. */
  identifiedVia: PrinterIdSource;
  /** The DuckDuckGo query run (only when a web lookup happened). */
  searchQuery?: string;
  /** Top search results used as evidence (provenance for the web-grounded guess). */
  sources?: WebSource[];
}

export interface TroubleshootSuggestion {
  hypothesis: string;
  change: string; // the concrete adjustment to make
  expectedOutcome: string; // what we should SEE if it worked
  watchFor: string; // visual signal to verify against
}

export interface TroubleshootSession {
  id: string;
  ts: number;
  status: "investigating" | "watching" | "resolved" | "failed";
  symptom: string;
  baselineSnapshot?: string;
  suggestions: TroubleshootSuggestion[];
  // verification observations after a change was applied
  observations: {
    ts: number;
    snapshotPath: string;
    verdict: "improved" | "no_change" | "worse" | "unclear";
    note: string;
  }[];
  notes: string[];
}
