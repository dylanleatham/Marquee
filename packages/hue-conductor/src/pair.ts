// One-time bridge pairing CLI: `pnpm --filter @marquee/hue-conductor pair`.
// Discovers bridges, waits for you to press the link button, saves the application key.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { BridgeAdapter } from "./bridge/adapter.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dataDir);
  const bridge = new BridgeAdapter(store);

  console.log("Discovering Hue bridges on your network…");
  const bridges = await bridge.discover();
  if (bridges.length === 0) {
    console.error(
      "No bridges found. Make sure the bridge is powered on and on the same LAN.",
    );
    process.exit(1);
  }
  bridges.forEach((b, i) =>
    console.log(`  [${i}] ${b.ip}  ${b.name ?? ""}  ${b.id ?? ""}`.trimEnd()),
  );

  const rl = createInterface({ input: stdin, output: stdout });
  const pick =
    bridges.length === 1
      ? "0"
      : await rl.question(`\nWhich bridge? [0-${bridges.length - 1}] `);
  const chosen = bridges[Number(pick)] ?? bridges[0]!;
  await rl.question(
    `\nPress the round LINK button on the bridge at ${chosen.ip}, then hit Enter… `,
  );
  rl.close();

  console.log("Pairing… (press the link button now if you haven't)");
  const record = await bridge.pair(chosen.ip);
  console.log(`\n✓ Paired with bridge ${record.id} at ${record.ip}.`);
  console.log(
    `  Application key saved to ${config.dataDir}/conductor.json (keep it out of git).`,
  );
  console.log(
    "  Start the service with: pnpm --filter @marquee/hue-conductor dev",
  );
}

main().catch((err: unknown) => {
  console.error("\nPairing failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
