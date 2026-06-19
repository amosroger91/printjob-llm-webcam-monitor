import express from "express";
import type { Request } from "express";
import { EventEmitter } from "node:events";
import os from "node:os";
import { join } from "node:path";
import { ROOT, publicConfig, saveConfig } from "../config.js";
import type { AppConfig } from "../types.js";
import type { CameraEntry } from "../capture/index.js";
import type { VisionProvider } from "../ai/provider.js";
import { store } from "../store/store.js";
import { prepareImage } from "../image/preprocess.js";
import { runFailureCheck } from "../analysis/failureCheck.js";
import { runBedStateCheck } from "../analysis/bedState.js";
import { runPrinterDetection } from "../analysis/printerDetect.js";
import { startTroubleshoot, verifyOutcome } from "../analysis/troubleshoot.js";
import { AlertManager } from "../alerts/index.js";
import type { Alert, BedStateResult, CheckResult } from "../types.js";

export function createServer(cfg: AppConfig, cameras: Map<string, CameraEntry>, ai: VisionProvider) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // Permissive CORS so the documented API is reachable from other local tools / Swagger UI.
  app.use((_req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    next();
  });
  app.options(/.*/, (_req, res) => res.sendStatus(204));

  const alerts = new AlertManager(cfg.alerts);
  const cameraList = [...cameras.values()];
  const defaultId = cameraList[0]?.id;

  // Resolve the target camera from ?camera=ID (defaults to the first configured one).
  const resolve = (req: Request): CameraEntry | undefined => {
    const id = String(req.query.camera ?? "") || defaultId;
    return cameras.get(id);
  };
  // Per-camera, per-operation busy flags so two cameras can run concurrently while a
  // single camera can't overlap its own checks.
  const busy = { check: new Set<string>(), bed: new Set<string>(), printer: new Set<string>() };

  // --- live event bus (SSE) for progress + alerts ---
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  const emit = (type: string, data: Record<string, unknown>) => bus.emit("evt", { type, data, ts: Date.now() });

  // Fire-and-forget alert dispatch (cooldown + enable handled by AlertManager). Keyed
  // per camera so each printer alerts independently.
  const fire = (alert: Alert) => {
    alerts
      .dispatch(alert)
      .then((results) => {
        if (results.length) emit("alert:sent", { key: alert.key, results });
      })
      .catch((e) => emit("alert:error", { error: (e as Error).message }));
  };
  const camName = (id?: string) => (id && cameras.get(id)?.label) || id || "camera";
  const maybeAlertCheck = (r: CheckResult) => {
    const critical = r.verdict === "failed";
    const warn = r.verdict === "uncertain" && cfg.alerts.notifyUncertain;
    if (!critical && !warn) return;
    fire({
      key: `check:${r.cameraId}:${r.verdict}`,
      level: critical ? "critical" : "warning",
      title: `${critical ? "Print failure detected" : "Print may be failing"} — ${camName(r.cameraId)}`,
      body: r.summary,
      ts: Date.now(),
    });
  };
  const maybeAlertBed = (r: BedStateResult) => {
    if (r.bedVisible === false) {
      fire({
        key: `bed:${r.cameraId}:nobed`,
        level: "critical",
        title: `No print bed detected — ${camName(r.cameraId)}`,
        body: r.summary,
        ts: Date.now(),
      });
      return;
    }
    if (r.state !== "failed") return;
    fire({
      key: `bed:${r.cameraId}:failed`,
      level: "critical",
      title: `Failed print on the bed — ${camName(r.cameraId)}`,
      body: r.summary,
      ts: Date.now(),
    });
  };

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

  // --- cameras ---
  app.get("/api/cameras", (_req, res) => {
    res.json(
      cameraList.map((c) => ({
        id: c.id,
        label: c.label,
        kind: c.source.kind,
        describe: c.source.describe(),
        latest: store.latestCheck(c.id) ?? null,
        latestBedState: store.latestBedState(c.id) ?? null,
        latestPrinter: store.latestPrinterDetection(c.id) ?? null,
      })),
    );
  });

  // --- status / health ---
  app.get("/api/status", async (_req, res) => {
    const health = await ai.health();
    const first = cameraList[0];
    res.json({
      // legacy single-camera fields point at the first camera for back-compat
      camera: first?.source.describe() ?? "none",
      cameraKind: first?.source.kind ?? "none",
      cameras: cameraList.map((c) => ({ id: c.id, label: c.label, kind: c.source.kind })),
      ai: { name: ai.name, ...health },
      check: cfg.check,
      alerts: { enabled: cfg.alerts.enabled },
      latest: store.latestCheck(defaultId) ?? null,
      latestBedState: store.latestBedState(defaultId) ?? null,
      latestPrinter: store.latestPrinterDetection(defaultId) ?? null,
    });
  });

  // --- live preview frame (preprocessed, as the model sees it) ---
  app.get("/api/snapshot", async (req, res) => {
    const cam = resolve(req);
    if (!cam) return res.status(404).json({ error: `unknown camera '${req.query.camera}'` });
    try {
      const raw = await cam.source.grab();
      const prepped = await prepareImage(raw, cfg.image);
      res.set("Content-Type", "image/jpeg").set("Cache-Control", "no-store").send(prepped.bytes);
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  // --- use case 1: failure check ---
  app.post("/api/check", async (req, res) => {
    const cam = resolve(req);
    if (!cam) return res.status(404).json({ error: `unknown camera '${req.query.camera}'` });
    if (busy.check.has(cam.id)) return res.status(409).json({ error: `a check is already running for ${cam.label}` });
    busy.check.add(cam.id);
    emit("check:start", { cameraId: cam.id });
    try {
      const result = await runFailureCheck(cam.source, ai, cfg, cam.id, (msg) => emit("check:progress", { cameraId: cam.id, msg }));
      emit("check:done", { cameraId: cam.id, result });
      maybeAlertCheck(result);
      res.json(result);
    } catch (e) {
      emit("check:error", { cameraId: cam.id, error: (e as Error).message });
      res.status(500).json({ error: (e as Error).message });
    } finally {
      busy.check.delete(cam.id);
    }
  });

  app.get("/api/checks", (req, res) => res.json(store.listChecks(50, req.query.camera ? String(req.query.camera) : undefined)));

  // --- use case 3: bed / job state ---
  app.post("/api/bed-state", async (req, res) => {
    const cam = resolve(req);
    if (!cam) return res.status(404).json({ error: `unknown camera '${req.query.camera}'` });
    if (busy.bed.has(cam.id)) return res.status(409).json({ error: `a bed-state check is already running for ${cam.label}` });
    busy.bed.add(cam.id);
    emit("bed:start", { cameraId: cam.id });
    try {
      const result = await runBedStateCheck(cam.source, ai, cfg, cam.id, (msg) => emit("bed:progress", { cameraId: cam.id, msg }));
      emit("bed:done", { cameraId: cam.id, result });
      maybeAlertBed(result);
      res.json(result);
    } catch (e) {
      emit("bed:error", { cameraId: cam.id, error: (e as Error).message });
      res.status(500).json({ error: (e as Error).message });
    } finally {
      busy.bed.delete(cam.id);
    }
  });

  app.get("/api/bed-states", (req, res) =>
    res.json(store.listBedStates(50, req.query.camera ? String(req.query.camera) : undefined)),
  );

  // --- use case 4: printer detection ---
  app.post("/api/printer", async (req, res) => {
    const cam = resolve(req);
    if (!cam) return res.status(404).json({ error: `unknown camera '${req.query.camera}'` });
    if (busy.printer.has(cam.id)) return res.status(409).json({ error: `a detection is already running for ${cam.label}` });
    busy.printer.add(cam.id);
    emit("printer:start", { cameraId: cam.id });
    try {
      const result = await runPrinterDetection(cam.source, ai, cfg, cam.id, (msg) => emit("printer:progress", { cameraId: cam.id, msg }));
      emit("printer:done", { cameraId: cam.id, result });
      res.json(result);
    } catch (e) {
      emit("printer:error", { cameraId: cam.id, error: (e as Error).message });
      res.status(500).json({ error: (e as Error).message });
    } finally {
      busy.printer.delete(cam.id);
    }
  });

  app.get("/api/printers", (req, res) =>
    res.json(store.listPrinterDetections(50, req.query.camera ? String(req.query.camera) : undefined)),
  );

  // --- alerts ---
  app.get("/api/alerts", (_req, res) => {
    res.json({ enabled: cfg.alerts.enabled, notifyUncertain: cfg.alerts.notifyUncertain, channels: alerts.status() });
  });

  app.post("/api/alerts/test", async (_req, res) => {
    const ready = alerts.readyChannels();
    if (ready.length === 0) {
      return res.status(400).json({ error: "no ready alert channels — enable one and provide its webhook/token (env or config)" });
    }
    const results = await alerts.send({
      key: "test",
      level: "warning",
      title: "print-watch test alert",
      body: "If you can read this, alerts are wired up correctly. 🎉",
      ts: Date.now(),
    });
    emit("alert:sent", { key: "test", results });
    res.json({ results });
  });

  // --- use case 2: troubleshooting (operates on the resolved camera) ---
  app.post("/api/troubleshoot", async (req, res) => {
    const cam = resolve(req);
    if (!cam) return res.status(404).json({ error: `unknown camera '${req.query.camera}'` });
    const symptom = String(req.body?.symptom ?? "").trim();
    if (!symptom) return res.status(400).json({ error: "symptom required" });
    try {
      emit("ts:start", { cameraId: cam.id, symptom });
      const session = await startTroubleshoot(cam.source, ai, cfg, symptom);
      emit("ts:diagnosed", { cameraId: cam.id, session });
      res.json(session);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post("/api/troubleshoot/:id/verify", async (req, res) => {
    const cam = resolve(req);
    if (!cam) return res.status(404).json({ error: `unknown camera '${req.query.camera}'` });
    const idx = Number(req.body?.suggestionIndex ?? 0);
    try {
      emit("ts:verifying", { id: req.params.id });
      const session = await verifyOutcome(cam.source, ai, cfg, req.params.id, idx);
      emit("ts:verified", { session });
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

  // --- optional mjpg-streamer-compatible webcam server (feed a USB cam into OctoPrint) ---
  // OctoPrint expects ?action=snapshot (one JPEG) and ?action=stream (multipart MJPEG).
  // We serve the RAW camera frame here (not the model-downscaled one) so it's full quality.
  // Always registered; gated on cfg.webcam.enabled live so the GUI can toggle it.
  {
    app.get(["/webcam", "/webcam/"], async (req, res) => {
      if (!cfg.webcam.enabled) return res.status(404).json({ error: "webcam server disabled" });
      const frameDelay = Math.max(50, Math.round(1000 / Math.max(1, cfg.webcam.fps)));
      const cam = resolve(req);
      if (!cam) return res.status(404).json({ error: `unknown camera '${req.query.camera}'` });
      const action = String(req.query.action ?? "snapshot");

      if (action === "snapshot") {
        try {
          const frame = await cam.source.grab();
          res.set("Content-Type", "image/jpeg").set("Cache-Control", "no-store").send(frame);
        } catch (e) {
          res.status(502).json({ error: (e as Error).message });
        }
        return;
      }

      if (action === "stream") {
        const boundary = "printwatchframe";
        res.writeHead(200, {
          "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Connection: "close",
          Pragma: "no-cache",
        });
        let alive = true;
        req.on("close", () => (alive = false));
        while (alive && !res.writableEnded) {
          try {
            const frame = await cam.source.grab();
            if (!alive) break;
            res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
            res.write(frame);
            res.write("\r\n");
          } catch {
            // transient grab failure — pause briefly and keep the stream open
          }
          await new Promise((r) => setTimeout(r, frameDelay));
        }
        res.end();
        return;
      }

      res.status(400).json({ error: "action must be 'snapshot' or 'stream'" });
    });
  }

  // --- system specs + model suggestion ---
  app.get("/api/system", (_req, res) => res.json(systemInfo()));

  // Stream `ollama pull <model>` progress (proxies Ollama's native pull API).
  app.post("/api/ollama/pull", async (req, res) => {
    const model = String(req.body?.model ?? "").trim();
    if (!model) return res.status(400).json({ error: "model required" });
    try {
      const r = await fetch(`${cfg.ai.baseUrl}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: model, stream: true }),
      });
      if (!r.ok || !r.body) return res.status(502).json({ error: `ollama pull returned ${r.status}` });
      res.set("Content-Type", "application/x-ndjson").set("Cache-Control", "no-store");
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
      res.end();
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
      else res.end();
    }
  });

  // --- configuration (GUI / API) ---
  app.get("/api/config", (_req, res) => res.json(publicConfig()));
  app.post("/api/config", (req, res) => {
    try {
      const result = saveConfig(req.body ?? {});
      emit("config:saved", result);
      res.json({ ok: true, ...result, config: publicConfig() });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // --- convenience routes for the extra pages ---
  app.get("/monitor", (_req, res) => res.sendFile(join(ROOT, "web", "monitor.html")));
  app.get("/docs", (_req, res) => res.sendFile(join(ROOT, "web", "docs.html")));
  app.get("/settings", (_req, res) => res.sendFile(join(ROOT, "web", "settings.html")));

  // --- static: snapshots + dashboard (also serves openapi.json) ---
  app.use("/snapshots", express.static(store.snapshotDir(), { maxAge: 0 }));
  app.use("/", express.static(join(ROOT, "web")));

  return { app, bus };
}

/** Read host specs and suggest an Ollama vision model sized to the machine's RAM. */
function systemInfo() {
  const ramGb = Math.round((os.totalmem() / 1e9) * 10) / 10;
  const cpus = os.cpus();
  let model: string, reason: string;
  if (ramGb < 6) {
    model = "moondream";
    reason = `Only ~${ramGb} GB RAM — a tiny, fast vision model is the safe choice.`;
  } else if (ramGb < 12) {
    model = "gemma3:4b";
    reason = `~${ramGb} GB RAM — a 4B model is a good balance of speed and accuracy.`;
  } else if (ramGb < 24) {
    model = "qwen2.5vl:7b";
    reason = `~${ramGb} GB RAM — you can run a 7B model for stronger accuracy.`;
  } else {
    model = "llama3.2-vision:11b";
    reason = `~${ramGb} GB RAM — plenty for an 11B vision model.`;
  }
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus[0]?.model?.trim() ?? "unknown",
    cpuCount: cpus.length,
    ramGb,
    suggestion: { model, reason, note: "A dedicated GPU makes checks dramatically faster but isn't required." },
  };
}
