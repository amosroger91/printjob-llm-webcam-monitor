import express from "express";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { ROOT } from "../config.js";
import type { AppConfig } from "../types.js";
import type { CaptureSource } from "../capture/index.js";
import type { VisionProvider } from "../ai/provider.js";
import { store } from "../store/store.js";
import { prepareImage } from "../image/preprocess.js";
import { runFailureCheck } from "../analysis/failureCheck.js";
import { runBedStateCheck } from "../analysis/bedState.js";
import { runPrinterDetection } from "../analysis/printerDetect.js";
import { startTroubleshoot, verifyOutcome } from "../analysis/troubleshoot.js";

export function createServer(cfg: AppConfig, source: CaptureSource, ai: VisionProvider) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // --- live event bus (SSE) for progress + alerts ---
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  const emit = (type: string, data: unknown) => bus.emit("evt", { type, data, ts: Date.now() });

  app.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(`: connected\n\n`);
    const onEvt = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    bus.on("evt", onEvt);
    const ping = setInterval(() => res.write(`: ping\n\n`), 20000);
    req.on("close", () => {
      clearInterval(ping);
      bus.off("evt", onEvt);
    });
  });

  // --- status / health ---
  app.get("/api/status", async (_req, res) => {
    const health = await ai.health();
    res.json({
      camera: source.describe(),
      cameraKind: source.kind,
      ai: { name: ai.name, ...health },
      check: cfg.check,
      latest: store.latestCheck() ?? null,
      latestBedState: store.latestBedState() ?? null,
      latestPrinter: store.latestPrinterDetection() ?? null,
    });
  });

  // --- live preview frame (preprocessed, as the model sees it) ---
  app.get("/api/snapshot", async (_req, res) => {
    try {
      const raw = await source.grab();
      const prepped = await prepareImage(raw, cfg.image);
      res.set("Content-Type", "image/jpeg").set("Cache-Control", "no-store").send(prepped.bytes);
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  // --- use case 1: failure check ---
  let checkRunning = false;
  app.post("/api/check", async (_req, res) => {
    if (checkRunning) return res.status(409).json({ error: "a check is already running" });
    checkRunning = true;
    emit("check:start", {});
    try {
      const result = await runFailureCheck(source, ai, cfg, (msg) => emit("check:progress", { msg }));
      emit("check:done", result);
      if (result.verdict === "failed") emit("alert", { summary: result.summary });
      res.json(result);
    } catch (e) {
      emit("check:error", { error: (e as Error).message });
      res.status(500).json({ error: (e as Error).message });
    } finally {
      checkRunning = false;
    }
  });

  app.get("/api/checks", (_req, res) => res.json(store.listChecks()));

  // --- use case 3: bed / job state ---
  let bedRunning = false;
  app.post("/api/bed-state", async (_req, res) => {
    if (bedRunning) return res.status(409).json({ error: "a bed-state check is already running" });
    bedRunning = true;
    emit("bed:start", {});
    try {
      const result = await runBedStateCheck(source, ai, cfg, (msg) => emit("bed:progress", { msg }));
      emit("bed:done", result);
      res.json(result);
    } catch (e) {
      emit("bed:error", { error: (e as Error).message });
      res.status(500).json({ error: (e as Error).message });
    } finally {
      bedRunning = false;
    }
  });

  app.get("/api/bed-states", (_req, res) => res.json(store.listBedStates()));

  // --- use case 4: printer detection ---
  let printerRunning = false;
  app.post("/api/printer", async (_req, res) => {
    if (printerRunning) return res.status(409).json({ error: "a printer detection is already running" });
    printerRunning = true;
    emit("printer:start", {});
    try {
      const result = await runPrinterDetection(source, ai, cfg, (msg) => emit("printer:progress", { msg }));
      emit("printer:done", result);
      res.json(result);
    } catch (e) {
      emit("printer:error", { error: (e as Error).message });
      res.status(500).json({ error: (e as Error).message });
    } finally {
      printerRunning = false;
    }
  });

  app.get("/api/printers", (_req, res) => res.json(store.listPrinterDetections()));

  // --- use case 2: troubleshooting ---
  app.post("/api/troubleshoot", async (req, res) => {
    const symptom = String(req.body?.symptom ?? "").trim();
    if (!symptom) return res.status(400).json({ error: "symptom required" });
    try {
      emit("ts:start", { symptom });
      const session = await startTroubleshoot(source, ai, cfg, symptom);
      emit("ts:diagnosed", session);
      res.json(session);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post("/api/troubleshoot/:id/verify", async (req, res) => {
    const idx = Number(req.body?.suggestionIndex ?? 0);
    try {
      emit("ts:verifying", { id: req.params.id });
      const session = await verifyOutcome(source, ai, cfg, req.params.id, idx);
      emit("ts:verified", session);
      res.json(session);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/sessions", (_req, res) => res.json(store.listSessions()));
  app.get("/api/sessions/:id", (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    res.json(s);
  });

  // --- static: snapshots + dashboard ---
  app.use("/snapshots", express.static(store.snapshotDir(), { maxAge: 0 }));
  app.use("/", express.static(join(ROOT, "web")));

  return { app, bus };
}
