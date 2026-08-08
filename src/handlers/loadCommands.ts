import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Client } from "discord.js";
import type { Command } from "../types/index.js";
import { logger } from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(__dirname, "..", "commands");

function findCommandFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...findCommandFiles(fullPath));
    } else if (entry.endsWith(".js") || (entry.endsWith(".ts") && !entry.endsWith(".d.ts"))) {
      files.push(fullPath);
    }
  }

  return files;
}

function isCommand(value: unknown): value is Command {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    "execute" in value &&
    typeof (value as Command).execute === "function"
  );
}

export async function loadCommands(client: Client): Promise<void> {
  const files = findCommandFiles(commandsDir);

  for (const file of files) {
    const module = await import(pathToFileURL(file).href);
    const command = module.default;

    if (!isCommand(command)) {
      logger.warn(`Il file "${file}" non esporta un Command valido (data/execute mancanti), verra' ignorato.`);
      continue;
    }

    client.commands.set(command.data.name, command);
  }

  logger.info(`Caricati ${client.commands.size} comandi.`);
}
