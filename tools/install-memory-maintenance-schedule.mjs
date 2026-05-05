import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const LOG_PATH = path.join(ROOT_DIR, "memory", "maintenance", "scheduled-maintenance.log");
const TASK_NAME = "portable-agent-memory-maintenance";

function shellQuote(value) {
  if (process.platform === "win32") {
    return `"${String(value).replaceAll('"', '\\"')}"`;
  }

  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} exited with ${result.status}`);
  }

  return result.stdout;
}

function installWindowsTask() {
  const taskCommand = `cmd.exe /d /c cd /d ${shellQuote(ROOT_DIR)} && npm run memory:maintain >> ${shellQuote(LOG_PATH)} 2>&1`;

  run("schtasks", [
    "/Create",
    "/F",
    "/SC",
    "DAILY",
    "/ST",
    "03:15",
    "/TN",
    TASK_NAME,
    "/TR",
    taskCommand
  ]);
}

function installCronTask() {
  const markerStart = "# BEGIN portable-agent-memory maintenance";
  const markerEnd = "# END portable-agent-memory maintenance";
  const current = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  const lines = current.status === 0 ? current.stdout.split(/\r?\n/) : [];
  const next = [];
  let skipping = false;

  for (const line of lines) {
    if (line === markerStart) {
      skipping = true;
      continue;
    }

    if (line === markerEnd) {
      skipping = false;
      continue;
    }

    if (!skipping && line.trim() !== "") {
      next.push(line);
    }
  }

  next.push(
    markerStart,
    `15 3 * * * cd ${shellQuote(ROOT_DIR)} && npm run memory:maintain >> ${shellQuote(LOG_PATH)} 2>&1`,
    markerEnd,
    ""
  );

  run("crontab", ["-"], { input: `${next.join("\n")}\n` });
}

function main() {
  if (process.platform === "win32") {
    installWindowsTask();
  } else {
    installCronTask();
  }

  process.stdout.write(`Installed ${TASK_NAME} for ${os.platform()} at ${ROOT_DIR}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
