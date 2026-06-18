import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";
import type { BedStateResult, CheckResult, PrinterDetectionResult, TroubleshootSession } from "../types.js";

interface DbShape {
  checks: CheckResult[];
  sessions: TroubleshootSession[];
  bedStates: BedStateResult[];
  printers: PrinterDetectionResult[];
}

const SNAP_DIR = join(DATA_DIR, "snapshots");
const DB_FILE = join(DATA_DIR, "store.json");
const MAX_CHECKS = 200;

// Tiny synchronous JSON store. No native deps, easy to inspect by hand. Fine for
// a single-user local dashboard; swap for SQLite if history grows large.
class Store {
  private db: DbShape = { checks: [], sessions: [], bedStates: [], printers: [] };

  init() {
    mkdirSync(SNAP_DIR, { recursive: true });
    if (existsSync(DB_FILE)) {
      try {
        this.db = JSON.parse(readFileSync(DB_FILE, "utf8"));
      } catch {
        /* start fresh on corrupt file */
      }
    }
    this.db.checks ??= [];
    this.db.sessions ??= [];
    this.db.bedStates ??= [];
    this.db.printers ??= [];
  }

  private persist() {
    writeFileSync(DB_FILE, JSON.stringify(this.db, null, 2));
  }

  /** Save raw snapshot bytes; returns the public relative URL path. */
  async saveSnapshot(id: string, bytes: Buffer): Promise<string> {
    const name = `${id}.jpg`;
    await writeFile(join(SNAP_DIR, name), bytes);
    return `/snapshots/${name}`;
  }

  snapshotDir() {
    return SNAP_DIR;
  }

  addCheck(c: CheckResult) {
    this.db.checks.unshift(c);
    if (this.db.checks.length > MAX_CHECKS) this.db.checks.length = MAX_CHECKS;
    this.persist();
  }

  listChecks(limit = 50) {
    return this.db.checks.slice(0, limit);
  }

  latestCheck() {
    return this.db.checks[0];
  }

  addBedState(b: BedStateResult) {
    this.db.bedStates.unshift(b);
    if (this.db.bedStates.length > MAX_CHECKS) this.db.bedStates.length = MAX_CHECKS;
    this.persist();
  }

  listBedStates(limit = 50) {
    return this.db.bedStates.slice(0, limit);
  }

  latestBedState() {
    return this.db.bedStates[0];
  }

  addPrinterDetection(p: PrinterDetectionResult) {
    this.db.printers.unshift(p);
    if (this.db.printers.length > MAX_CHECKS) this.db.printers.length = MAX_CHECKS;
    this.persist();
  }

  listPrinterDetections(limit = 50) {
    return this.db.printers.slice(0, limit);
  }

  latestPrinterDetection() {
    return this.db.printers[0];
  }

  addSession(s: TroubleshootSession) {
    this.db.sessions.unshift(s);
    this.persist();
  }

  getSession(id: string) {
    return this.db.sessions.find((s) => s.id === id);
  }

  updateSession(s: TroubleshootSession) {
    const i = this.db.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) this.db.sessions[i] = s;
    else this.db.sessions.unshift(s);
    this.persist();
  }

  listSessions() {
    return this.db.sessions;
  }
}

export const store = new Store();
