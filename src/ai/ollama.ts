import type { AiConfig } from "../types.js";
import type { VisionProvider, VisionRequest } from "./provider.js";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

// Talks to a local Ollama server (/api/chat). Uses Ollama's structured-output
// `format` field to force schema-valid JSON, and temperature 0 for determinism
// so the self-consistency vote reflects genuine model uncertainty, not sampling.
export class OllamaVisionProvider implements VisionProvider {
  constructor(private cfg: AiConfig) {}

  get name(): string {
    return `ollama:${this.cfg.model}`;
  }

  private async chat(req: VisionRequest): Promise<string> {
    const messages: ChatMessage[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt, images: req.images });

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      stream: false,
      options: {
        temperature: req.temperature ?? this.cfg.temperature,
        num_ctx: this.cfg.numCtx,
      },
    };
    if (req.schema) body.format = req.schema;

    const res = await fetch(`${this.cfg.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ollama /api/chat ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? "";
  }

  async complete(req: VisionRequest): Promise<string> {
    return this.chat(req);
  }

  async json<T>(req: VisionRequest & { schema: Record<string, unknown> }): Promise<T> {
    const raw = await this.chat(req);
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Salvage: pull the first {...} block if the model wrapped it in prose.
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]) as T;
      throw new Error(`model did not return JSON: ${raw.slice(0, 200)}`);
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return { ok: false, detail: `ollama returned ${res.status}` };
      const data = (await res.json()) as { models?: { name: string }[] };
      const names = (data.models ?? []).map((m) => m.name);
      const has = names.some((n) => n === this.cfg.model || n.startsWith(this.cfg.model.split(":")[0]));
      return has
        ? { ok: true, detail: `model ${this.cfg.model} available` }
        : { ok: false, detail: `model ${this.cfg.model} not pulled. Run: ollama pull ${this.cfg.model}` };
    } catch (e) {
      return { ok: false, detail: `ollama unreachable at ${this.cfg.baseUrl}: ${(e as Error).message}` };
    }
  }
}
