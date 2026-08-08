import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Client } from "discord.js";
import type { Event } from "../types/index.js";
import { logger } from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const eventsDir = join(__dirname, "..", "events");

function isEvent(value: unknown): value is Event {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "execute" in value &&
    typeof (value as Event).execute === "function"
  );
}

export async function loadEvents(client: Client): Promise<void> {
  const files = readdirSync(eventsDir).filter(
    (file) => file.endsWith(".js") || (file.endsWith(".ts") && !file.endsWith(".d.ts")),
  );

  let count = 0;

  for (const file of files) {
    const fullPath = join(eventsDir, file);
    const module = await import(pathToFileURL(fullPath).href);
    const event = module.default;

    if (!isEvent(event)) {
      logger.warn(`Il file "${fullPath}" non esporta un Event valido (name/execute mancanti), verra' ignorato.`);
      continue;
    }

    if (event.once) {
      client.once(event.name, event.execute);
    } else {
      client.on(event.name, event.execute);
    }
    count++;
  }

  logger.info(`Caricati ${count} eventi.`);
}
