import type { AiConfig } from "../types.js";
import type { VisionProvider, VisionRequest } from "./provider.js";
import { OllamaVisionProvider } from "./ollama.js";
import { GeminiVisionProvider } from "./gemini.js";

/**
 * Routes every call to the provider named by `cfg.provider`, read LIVE — so
 * switching provider/model/key in the settings GUI takes effect immediately,
 * no restart. Both backends share the same `cfg` reference.
 */
export class DispatchVisionProvider implements VisionProvider {
  private providers: Record<string, VisionProvider>;
  constructor(private cfg: AiConfig) {
    this.providers = { ollama: new OllamaVisionProvider(cfg), gemini: new GeminiVisionProvider(cfg) };
  }
  private get active(): VisionProvider {
    return this.providers[this.cfg.provider] ?? this.providers.ollama;
  }
  get name(): string {
    return this.active.name;
  }
  complete(req: VisionRequest): Promise<string> {
    return this.active.complete(req);
  }
  json<T>(req: VisionRequest & { schema: Record<string, unknown> }): Promise<T> {
    return this.active.json<T>(req);
  }
  health(): Promise<{ ok: boolean; detail: string }> {
    return this.active.health();
  }
}
