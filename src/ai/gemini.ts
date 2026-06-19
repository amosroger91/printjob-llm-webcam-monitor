import type { AiConfig } from "../types.js";
import type { VisionProvider, VisionRequest } from "./provider.js";

// Google Gemini vision backend — an optional cloud alternative to local Ollama.
// Uses the Generative Language REST API with structured output (responseSchema)
// so it returns schema-valid JSON, same contract as the Ollama provider.
//
// NOTE: with Gemini, frames ARE sent to Google — this is the one backend that
// breaks the "no images leave your machine" guarantee. It's opt-in via config.
const GEMINI_BASE = "https://generativelanguage.googleapis.com";

export class GeminiVisionProvider implements VisionProvider {
  constructor(private cfg: AiConfig) {}

  get name(): string {
    return `gemini:${this.cfg.model}`;
  }

  private url(method: string): string {
    return `${GEMINI_BASE}/v1beta/models/${this.cfg.model}:${method}?key=${this.cfg.apiKey ?? ""}`;
  }

  private async generate(req: VisionRequest): Promise<string> {
    if (!this.cfg.apiKey) throw new Error("no Gemini API key — set ai.apiKey (or PW_GEMINI_API_KEY)");
    const parts: Record<string, unknown>[] = [{ text: req.prompt }];
    for (const img of req.images) parts.push({ inline_data: { mime_type: "image/jpeg", data: img } });

    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: req.temperature ?? this.cfg.temperature,
        ...(req.schema ? { responseMimeType: "application/json", responseSchema: toGeminiSchema(req.schema) } : {}),
      },
    };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };

    const res = await fetch(this.url("generateContent"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`gemini ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  async complete(req: VisionRequest): Promise<string> {
    return this.generate(req);
  }

  async json<T>(req: VisionRequest & { schema: Record<string, unknown> }): Promise<T> {
    const raw = await this.generate(req);
    try {
      return JSON.parse(raw) as T;
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]) as T;
      throw new Error(`gemini did not return JSON: ${raw.slice(0, 200)}`);
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!this.cfg.apiKey) return { ok: false, detail: "Gemini API key not set" };
    try {
      const res = await fetch(`${GEMINI_BASE}/v1beta/models?key=${this.cfg.apiKey}`, { signal: AbortSignal.timeout(5000) });
      return res.ok
        ? { ok: true, detail: `gemini ${this.cfg.model} reachable` }
        : { ok: false, detail: `Gemini API returned ${res.status} (check the key)` };
    } catch (e) {
      return { ok: false, detail: `Gemini unreachable: ${(e as Error).message}` };
    }
  }
}

/** Convert our JSON-Schema subset to Gemini's responseSchema (uppercase types). */
function toGeminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (s && typeof s === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
      if (k === "type" && typeof v === "string") out.type = v.toUpperCase();
      else if (k === "properties" && v && typeof v === "object") {
        const props: Record<string, unknown> = {};
        for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) props[pk] = toGeminiSchema(pv);
        out.properties = props;
      } else if (k === "items") out.items = toGeminiSchema(v);
      else out[k] = v; // enum, required, etc. pass through
    }
    return out;
  }
  return s;
}
