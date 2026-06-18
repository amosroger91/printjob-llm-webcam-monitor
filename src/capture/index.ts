import type { CameraConfig } from "../types.js";
import type { CaptureSource } from "./source.js";
import { HttpSnapshotSource } from "./httpSnapshot.js";
import { MjpegSource } from "./mjpeg.js";
import { UsbWebcamSource } from "./usbWebcam.js";
import { FolderSource } from "./folder.js";

export type { CaptureSource } from "./source.js";

export function createCaptureSource(cfg: CameraConfig): CaptureSource {
  switch (cfg.type) {
    case "http-snapshot":
      if (!cfg.url) throw new Error("camera.url required for http-snapshot");
      return new HttpSnapshotSource(cfg.url);
    case "mjpeg":
      if (!cfg.url) throw new Error("camera.url required for mjpeg");
      return new MjpegSource(cfg.url);
    case "usb":
      return new UsbWebcamSource(cfg.usbDevice ?? "", cfg.ffmpegPath);
    case "folder":
      if (!cfg.folderPath) throw new Error("camera.folderPath required for folder");
      return new FolderSource(cfg.folderPath);
    default:
      throw new Error(`unknown camera type: ${(cfg as CameraConfig).type}`);
  }
}
