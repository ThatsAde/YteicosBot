import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REST, Routes } from "discord.js";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";
import type { Command } from "./types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(__dirname, "commands");

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

async function deployCommands(): Promise<void> {
  const files = findCommandFiles(commandsDir);
  const body = [];

  for (const file of files) {
    const module = await import(pathToFileURL(file).href);
    const command: Command = module.default;
    body.push(command.data.toJSON());
  }

  const rest = new REST().setToken(config.token);

  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  logger.info(
    config.guildId
      ? `Registering ${body.length} commands on guild ${config.guildId} (dev)...`
      : `Registering ${body.length} commands globally (can take up to 1 hour to propagate)...`,
  );

  try {
    await rest.put(route, { body });
    logger.info("Commands registered successfully.");
  } catch (error) {
    logger.error("Command registration failed.", error);
    process.exitCode = 1;
  }
}

void deployCommands();
