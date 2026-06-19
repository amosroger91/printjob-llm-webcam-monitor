import { config } from "./config.js";
import { store } from "./store/store.js";
import { createCameraRegistry } from "./capture/index.js";
import { DispatchVisionProvider } from "./ai/dispatch.js";
import { createServer } from "./server/server.js";

async function main() {
  store.init();

  const cameras = createCameraRegistry(config.cameras);
  const ai = new DispatchVisionProvider(config.ai);
  const { app } = createServer(config, cameras, ai);

  const { port, host } = config.server;
  app.listen(port, host, async () => {
    console.log(`\n  🍝 SpaghettiAI  →  http://${host}:${port}`);
    console.log(`  cameras: ${cameras.size}`);
    for (const c of cameras.values()) console.log(`    • ${c.id} (${c.label}) — ${c.source.describe()}`);
    const health = await ai.health();
    console.log(`  ai:      ${ai.name} — ${health.ok ? "OK" : "⚠ " + health.detail}`);
    if (!health.ok) {
      console.log(`           (the dashboard still loads; fix the model/server and retry a check)`);
    }
    console.log("");
  });
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
