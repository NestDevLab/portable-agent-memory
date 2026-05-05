import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, "memory-maintenance.config.json");
const ARCHIVE_ENTRIES_MARKER = "## Archived Entries";
const TOP_LEVEL_HEADER_RE = /^## .*(?:\r?\n|$)/gm;
const ISO_DATE_ONLY_RE = /^## (\d{4}-\d{2}-\d{2})$/;
const ISO_DATE_TITLE_RE = /^## (\d{4}-\d{2}-\d{2}) - .+$/;
const TEMP_WORKSPACE_IGNORED_PREFIXES = [".codex/"];
const TEMP_WORKSPACE_IGNORED_PATHS = new Set([".codex"]);

function loadConfig(configPath = CONFIG_PATH) {
  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);

  if (!Array.isArray(config.managedLogs) || config.managedLogs.length === 0) {
    throw new Error("memory-maintenance config requires at least one managed log");
  }

  if (!config.codex || typeof config.codex !== "object") {
    config.codex = {};
  }

  if (typeof config.codex.model !== "string" || config.codex.model.trim() === "") {
    config.codex.model = "gpt-5.4";
  }

  if (
    typeof config.codex.reasoningEffort !== "string" ||
    config.codex.reasoningEffort.trim() === ""
  ) {
    config.codex.reasoningEffort = "medium";
  }

  return config;
}

function toPosixPath(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function resolveWorkspacePath(workspaceRoot, relativePath) {
  return path.join(workspaceRoot, relativePath);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function safeReadFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function safeWriteFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function hashContent(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function utcDateAtStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function subtractDays(date, days) {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

function getQuarterInfo(date) {
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  const year = date.getUTCFullYear();

  return {
    quarter,
    year,
    key: `${year}-Q${quarter}`
  };
}

function isDateOlderThanCutoff(date, cutoffDate) {
  return date.getTime() < cutoffDate.getTime();
}

function getActiveEntryLimit(logConfig) {
  if (Number.isInteger(logConfig.activeEntryLimit) && logConfig.activeEntryLimit > 0) {
    return logConfig.activeEntryLimit;
  }

  return null;
}

function getLogTitle(sourcePath, content) {
  const match = content.match(/^# (.+)$/m);
  return match ? match[1].trim() : path.basename(sourcePath, path.extname(sourcePath));
}

function parseLogSections(content) {
  const sections = [];
  const matches = Array.from(content.matchAll(TOP_LEVEL_HEADER_RE));
  const prefix = matches.length === 0 ? content : content.slice(0, matches[0].index);

  if (matches.length === 0) {
    return { prefix, sections };
  }

  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index;
    const end = index + 1 < matches.length ? matches[index + 1].index : content.length;
    const block = content.slice(start, end);
    const headerLine = matches[index][0].trimEnd();
    const datedMatch = headerLine.match(/^## (\d{4}-\d{2}-\d{2})(?: - .+)?$/);
    const parsedDate = datedMatch ? parseIsoDate(datedMatch[1]) : null;
    let kind = "other";

    if (datedMatch && parsedDate) {
      kind = ISO_DATE_TITLE_RE.test(headerLine) ? "dated" : "legacy-dated";
    }

    sections.push({
      block,
      date: parsedDate,
      dateString: datedMatch ? datedMatch[1] : null,
      headerLine,
      kind
    });
  }

  return { prefix, sections };
}

function getArchiveRelativePath(config, logConfig, entryDate) {
  const quarterInfo = getQuarterInfo(entryDate);
  return toPosixPath(
    path.join(
      config.archiveRoot,
      logConfig.archiveKey,
      `${quarterInfo.year}`,
      `${quarterInfo.key}.md`
    )
  );
}

function buildArchivePreamble({ sourcePath, title, retentionDays, quarterKey }) {
  return [
    `# ${title} Archive - ${quarterKey}`,
    "",
    `This file is a mechanical archive slice for \`${sourcePath}\`.`,
    "Archived entries are copied from the source log without semantic edits.",
    "",
    "## Archive Metadata",
    "",
    `- Source log: \`${sourcePath}\``,
    `- Retention policy: keep the last \`${retentionDays}\` days in the active log`,
    `- Archive slice: \`${quarterKey}\``,
    "",
    ARCHIVE_ENTRIES_MARKER,
    ""
  ].join("\n");
}

function appendArchiveEntries(workspaceRoot, config, logConfig, sourceTitle, archiveRelativePath, blocks) {
  const archivePath = resolveWorkspacePath(workspaceRoot, archiveRelativePath);
  const quarterKey = path.basename(archiveRelativePath, ".md");
  const newEntries = [];

  ensureDir(path.dirname(archivePath));

  if (!fileExists(archivePath)) {
    const preamble = buildArchivePreamble({
      sourcePath: logConfig.source,
      title: sourceTitle,
      retentionDays: config.retentionDays,
      quarterKey
    });
    const content = `${preamble}${blocks.join("")}`;
    safeWriteFile(archivePath, content);
    return {
      appendedCount: blocks.length,
      skippedCount: 0
    };
  }

  const currentContent = safeReadFile(archivePath);

  if (!currentContent.includes(ARCHIVE_ENTRIES_MARKER)) {
    throw new Error(`Malformed archive file missing "${ARCHIVE_ENTRIES_MARKER}": ${archiveRelativePath}`);
  }

  for (const block of blocks) {
    if (!currentContent.includes(block)) {
      newEntries.push(block);
    }
  }

  if (newEntries.length === 0) {
    return {
      appendedCount: 0,
      skippedCount: blocks.length
    };
  }

  const separator = currentContent.endsWith("\n\n") ? "" : currentContent.endsWith("\n") ? "\n" : "\n\n";
  const updatedContent = `${currentContent}${separator}${newEntries.join("")}`;
  safeWriteFile(archivePath, updatedContent);

  return {
    appendedCount: newEntries.length,
    skippedCount: blocks.length - newEntries.length
  };
}

function rotateLogFile(workspaceRoot, config, logConfig, options = {}) {
  const now = options.now ? utcDateAtStart(options.now) : utcDateAtStart(new Date());
  const dryRun = Boolean(options.dryRun);
  const logPath = resolveWorkspacePath(workspaceRoot, logConfig.source);

  if (!fileExists(logPath)) {
    throw new Error(`Managed log file is missing: ${logConfig.source}`);
  }

  const content = safeReadFile(logPath);
  const title = getLogTitle(logConfig.source, content);
  const parsed = parseLogSections(content);
  const cutoffDate = subtractDays(now, config.retentionDays);
  const retainedBlocks = [];
  const archiveBuckets = new Map();
  const warnings = [];
  const rotatedEntries = [];
  const activeEntryLimit = getActiveEntryLimit(logConfig);
  const datedSections = parsed.sections.filter((section) => section.kind === "dated" || section.kind === "legacy-dated");
  let datedSectionIndex = 0;

  for (const section of parsed.sections) {
    if (section.kind === "dated" || section.kind === "legacy-dated") {
      datedSectionIndex += 1;
      if (section.kind === "legacy-dated") {
        warnings.push(`Legacy dated header retained for compatibility: ${section.headerLine}`);
      }

      const rotationReason =
        activeEntryLimit !== null && datedSectionIndex > activeEntryLimit
          ? `active entry limit ${activeEntryLimit}`
          : isDateOlderThanCutoff(section.date, cutoffDate)
            ? `retention cutoff ${cutoffDate.toISOString().slice(0, 10)}`
            : null;

      if (rotationReason) {
        const archiveRelativePath = getArchiveRelativePath(config, logConfig, section.date);
        const bucket = archiveBuckets.get(archiveRelativePath) ?? [];
        bucket.push(section.block);
        archiveBuckets.set(archiveRelativePath, bucket);
        rotatedEntries.push({
          archivePath: archiveRelativePath,
          date: section.dateString,
          header: section.headerLine,
          reason: rotationReason
        });
        continue;
      }
    } else if (section.headerLine.startsWith("## ")) {
      warnings.push(`Non-dated top-level section left in place: ${section.headerLine}`);
    }

    retainedBlocks.push(section.block);
  }

  const updatedActiveContent = `${parsed.prefix}${retainedBlocks.join("")}`;
  const changed = updatedActiveContent !== content;
  const archiveWrites = [];

  if (!dryRun) {
    for (const [archiveRelativePath, blocks] of [...archiveBuckets.entries()].sort(([left], [right]) => {
      return left.localeCompare(right);
    })) {
      const archiveWrite = appendArchiveEntries(
        workspaceRoot,
        config,
        logConfig,
        title,
        archiveRelativePath,
        blocks
      );
      archiveWrites.push({
        archivePath: archiveRelativePath,
        ...archiveWrite
      });
    }

    if (changed) {
      safeWriteFile(logPath, updatedActiveContent);
    }
  } else {
    for (const [archiveRelativePath, blocks] of archiveBuckets.entries()) {
      archiveWrites.push({
        archivePath: archiveRelativePath,
        appendedCount: blocks.length,
        skippedCount: 0
      });
    }
  }

  return {
    archiveWrites,
    activeEntryLimit,
    changed,
    cutoffDate: cutoffDate.toISOString().slice(0, 10),
    datedEntryCount: datedSections.length,
    retainedDatedEntryCount: datedSections.length - rotatedEntries.length,
    retainedEntryCount: retainedBlocks.length,
    rotatedCount: rotatedEntries.length,
    rotatedEntries,
    source: logConfig.source,
    warnings
  };
}

function validateManagedLogsExist(workspaceRoot, config) {
  for (const logConfig of config.managedLogs) {
    const logPath = resolveWorkspacePath(workspaceRoot, logConfig.source);
    if (!fileExists(logPath)) {
      throw new Error(`Managed log file is missing: ${logConfig.source}`);
    }
  }
}

function rotateManagedLogs(workspaceRoot, config, options = {}) {
  validateManagedLogsExist(workspaceRoot, config);
  return config.managedLogs.map((logConfig) => rotateLogFile(workspaceRoot, config, logConfig, options));
}

function listArchiveSlicesForLog(workspaceRoot, config, logConfig) {
  const archiveDir = resolveWorkspacePath(workspaceRoot, path.join(config.archiveRoot, logConfig.archiveKey));
  const files = [];

  if (!fileExists(archiveDir)) {
    return files;
  }

  const stack = [archiveDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = toPosixPath(path.relative(workspaceRoot, absolutePath));

      if (!relativePath.endsWith(".md") || relativePath.endsWith("/index.md")) {
        continue;
      }

      files.push(relativePath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function countDatedEntriesInMarkdown(content) {
  const parsed = parseLogSections(content);
  return parsed.sections.filter((section) => section.kind === "dated" || section.kind === "legacy-dated").length;
}

function buildPerLogArchiveIndex(workspaceRoot, config, logConfig, archiveFiles) {
  const lines = [
    `# ${logConfig.archiveKey} Archive Index`,
    "",
    `Archive slices for \`${logConfig.source}\`.`,
    "",
    "## Policy",
    "",
    `- Keep the last \`${config.retentionDays}\` days in the active log.`,
    "- Archive older dated entries quarterly.",
    "- Archive files are append-only and keep copied entries unchanged.",
    ""
  ];

  if (archiveFiles.length === 0) {
    lines.push("## Files", "", "No archive files exist yet.", "");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Files", "");

  let currentYear = "";
  for (const archiveFile of archiveFiles) {
    const parts = archiveFile.split("/");
    const year = parts[2];
    const fileName = path.basename(archiveFile);
    const content = safeReadFile(resolveWorkspacePath(workspaceRoot, archiveFile));
    const count = countDatedEntriesInMarkdown(content);
    const relativeLink = path.relative(
      resolveWorkspacePath(workspaceRoot, path.join(config.archiveRoot, logConfig.archiveKey)),
      resolveWorkspacePath(workspaceRoot, archiveFile)
    );

    if (year !== currentYear) {
      if (currentYear !== "") {
        lines.push("");
      }
      lines.push(`### ${year}`, "");
      currentYear = year;
    }

    lines.push(`- [${fileName}](${toPosixPath(relativeLink)}) - ${count} archived entries`);
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function buildGlobalArchiveIndex(config, summaries) {
  const lines = [
    "# Archive Index",
    "",
    "Deterministic archive indexes for rotated workspace logs.",
    "",
    "## Managed Logs",
    ""
  ];

  for (const summary of summaries) {
    const relativeLink = `${summary.archiveKey}/index.md`;
    const filesLabel = summary.archiveFileCount === 1 ? "archive file" : "archive files";
    lines.push(
      `- [${summary.archiveKey}](${relativeLink}) - ${summary.archiveFileCount} ${filesLabel}, ${summary.archivedEntryCount} archived entries`
    );
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function regenerateArchiveIndexes(workspaceRoot, config, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const summaries = [];
  const writes = [];

  if (!dryRun) {
    ensureDir(resolveWorkspacePath(workspaceRoot, config.archiveRoot));
  }

  for (const logConfig of config.managedLogs) {
    const logArchiveDir = resolveWorkspacePath(workspaceRoot, path.join(config.archiveRoot, logConfig.archiveKey));
    if (!dryRun) {
      ensureDir(logArchiveDir);
    }

    const archiveFiles = listArchiveSlicesForLog(workspaceRoot, config, logConfig);
    let archivedEntryCount = 0;

    for (const archiveFile of archiveFiles) {
      const content = safeReadFile(resolveWorkspacePath(workspaceRoot, archiveFile));
      archivedEntryCount += countDatedEntriesInMarkdown(content);
    }

    const perLogIndexPath = path.join(config.archiveRoot, logConfig.archiveKey, "index.md");
    const perLogIndexContent = buildPerLogArchiveIndex(workspaceRoot, config, logConfig, archiveFiles);
    summaries.push({
      archiveFileCount: archiveFiles.length,
      archiveKey: logConfig.archiveKey,
      archivedEntryCount,
      indexPath: toPosixPath(perLogIndexPath)
    });

    if (!dryRun) {
      safeWriteFile(resolveWorkspacePath(workspaceRoot, perLogIndexPath), perLogIndexContent);
    }

    writes.push(toPosixPath(perLogIndexPath));
  }

  const globalIndexPath = path.join(config.archiveRoot, "index.md");
  const globalIndexContent = buildGlobalArchiveIndex(config, summaries);

  if (!dryRun) {
    safeWriteFile(resolveWorkspacePath(workspaceRoot, globalIndexPath), globalIndexContent);
  }

  writes.push(toPosixPath(globalIndexPath));

  return {
    writes,
    summaries
  };
}

function listFilesRecursive(rootDir) {
  if (!fileExists(rootDir)) {
    return [];
  }

  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function shouldIgnoreTempWorkspacePath(relativePath) {
  const normalized = toPosixPath(relativePath);

  if (TEMP_WORKSPACE_IGNORED_PATHS.has(normalized)) {
    return true;
  }

  return TEMP_WORKSPACE_IGNORED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function snapshotFiles(rootDir) {
  const snapshot = new Map();
  for (const filePath of listFilesRecursive(rootDir)) {
    const relativePath = toPosixPath(path.relative(rootDir, filePath));
    if (shouldIgnoreTempWorkspacePath(relativePath)) {
      continue;
    }
    snapshot.set(relativePath, hashContent(fs.readFileSync(filePath)));
  }
  return snapshot;
}

function copyRecursive(sourcePath, targetPath) {
  const stats = fs.statSync(sourcePath);

  if (stats.isDirectory()) {
    ensureDir(targetPath);
    for (const entry of fs.readdirSync(sourcePath)) {
      copyRecursive(path.join(sourcePath, entry), path.join(targetPath, entry));
    }
    return;
  }

  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function makeReadOnlyTree(rootDir, writableMatcher) {
  for (const filePath of listFilesRecursive(rootDir)) {
    const relativePath = toPosixPath(path.relative(rootDir, filePath));
    const mode = writableMatcher(relativePath) ? 0o644 : 0o444;
    fs.chmodSync(filePath, mode);
  }
}

function buildCodexAllowRules(config) {
  const workspace = config.workspace ?? {};
  const indexPath = typeof workspace.indexPath === "string" && workspace.indexPath.trim() !== ""
    ? workspace.indexPath
    : "memory/index.md";
  const exactPaths = new Set([
    indexPath,
    path.join(config.archiveRoot, "index.md"),
    ...config.managedLogs.map((logConfig) => path.join(config.archiveRoot, logConfig.archiveKey, "index.md"))
  ].map(toPosixPath));

  const prefixPaths = [
    `${toPosixPath(config.summariesRoot)}/`,
    `${toPosixPath(config.maintenanceRoot)}/`
  ];

  return {
    exactPaths,
    prefixPaths
  };
}

function isPathAllowedForCodex(relativePath, allowRules) {
  const normalized = toPosixPath(relativePath);

  if (allowRules.exactPaths.has(normalized)) {
    return true;
  }

  return allowRules.prefixPaths.some((prefix) => normalized.startsWith(prefix));
}

function buildCodexPrompt(config, manifest) {
  const managedLogs = config.managedLogs.map((logConfig) => `- \`${logConfig.source}\``).join("\n");
  const allowedWrites = manifest.allowedWritePaths.map((entry) => `- \`${entry}\``).join("\n");
  const protectedPaths = manifest.protectedPaths.map((entry) => `- \`${entry}\``).join("\n");
  const workspace = config.workspace ?? {};
  const workspaceName = workspace.name ?? "Markdown memory workspace";
  const workspaceDescription = workspace.description ?? "A markdown knowledge base maintained by an AI agent.";
  const indexPath = workspace.indexPath ?? "memory/index.md";
  const llmWikiPath = workspace.llmWikiPath ?? "memory/agent-memory/llm-wiki.md";
  const policyPaths = Array.isArray(workspace.policyPaths) ? workspace.policyPaths : [];
  const policySection =
    policyPaths.length > 0
      ? policyPaths.map((entry) => `- \`${entry}\``).join("\n")
      : "- No additional policy paths configured.";
  const rotatedEntries = manifest.rotation.flatMap((entry) => {
    return entry.rotatedEntries.map((rotatedEntry) => {
      const reason = rotatedEntry.reason ? ` (${rotatedEntry.reason})` : "";
      return `- ${entry.source}: ${rotatedEntry.header} -> \`${rotatedEntry.archivePath}\`${reason}`;
    });
  });
  const rotatedSection = rotatedEntries.length > 0 ? rotatedEntries.join("\n") : "- No entries rotated in this run.";

  return [
    `You are maintaining ${workspaceName}.`,
    "",
    workspaceDescription,
    "",
    `Use the persistent wiki pattern from \`${llmWikiPath}\` when that file exists. Stay within any local policy files configured for this workspace.`,
    "",
    "Policy files to respect if present:",
    policySection,
    "",
    "This run is bounded. You may only modify the explicitly allowed outputs listed below. Do not modify archives, policy docs, project notes, or any other files.",
    "",
    "Managed logs:",
    managedLogs,
    "",
    "Rotated entries in this run:",
    rotatedSection,
    "",
    "Allowed write targets:",
    allowedWrites,
    "",
    "Do not modify:",
    protectedPaths,
    "",
    "Required tasks:",
    `1. Update \`${indexPath}\` as the top-level wiki-style entrypoint for the memory workspace if it is in the allowed write targets.`,
    "2. Update any relevant archive index pages only if the rotated/archive state changed.",
    `3. Create or refresh quarter summaries under \`${config.summariesRoot}/\` where useful, especially for the current quarter or any quarter touched by rotated entries.`,
    "4. Keep wording concise, factual, and consistent with the workspace documentation style.",
    "5. If no semantic updates are needed, leave files unchanged.",
    "",
    "Never rewrite archived entries. Never edit policy files, raw source files, or any files outside the allowlist.",
    "",
    `The run manifest is available at the path listed inside \`${config.maintenanceRoot}/\` for this run.`
  ].join("\n");
}

function createTempWorkspace(workspaceRoot, config, allowRules) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portable-agent-memory-maintenance-"));

  for (const relativePath of config.readContextPaths) {
    const sourcePath = resolveWorkspacePath(workspaceRoot, relativePath);
    if (!fileExists(sourcePath)) {
      continue;
    }

    const targetPath = resolveWorkspacePath(tempRoot, relativePath);
    copyRecursive(sourcePath, targetPath);
  }

  makeReadOnlyTree(tempRoot, (relativePath) => isPathAllowedForCodex(relativePath, allowRules));

  return tempRoot;
}

function diffSnapshots(beforeSnapshot, afterSnapshot) {
  const changes = [];
  const allPaths = new Set([...beforeSnapshot.keys(), ...afterSnapshot.keys()]);

  for (const relativePath of [...allPaths].sort((left, right) => left.localeCompare(right))) {
    const before = beforeSnapshot.get(relativePath);
    const after = afterSnapshot.get(relativePath);

    if (before === after) {
      continue;
    }

    if (before && !after) {
      changes.push({ path: relativePath, type: "deleted" });
    } else if (!before && after) {
      changes.push({ path: relativePath, type: "created" });
    } else {
      changes.push({ path: relativePath, type: "modified" });
    }
  }

  return changes;
}

function validateCodexChanges(changes, allowRules) {
  const invalid = changes.filter((change) => !isPathAllowedForCodex(change.path, allowRules) || change.type === "deleted");
  return {
    invalid,
    valid: changes.filter((change) => !invalid.includes(change))
  };
}

function copyBackAllowedChanges(tempRoot, workspaceRoot, changes) {
  for (const change of changes) {
    const sourcePath = resolveWorkspacePath(tempRoot, change.path);
    const targetPath = resolveWorkspacePath(workspaceRoot, change.path);
    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function collectWorkspaceStats(workspaceRoot) {
  const memoryDir = resolveWorkspacePath(workspaceRoot, "memory");
  const sourcesDir = resolveWorkspacePath(workspaceRoot, "memory/sources");

  return {
    memoryMarkdownFiles: listFilesRecursive(memoryDir).filter((filePath) => filePath.endsWith(".md")).length,
    sourceMarkdownFiles: listFilesRecursive(sourcesDir).filter((filePath) => filePath.endsWith(".md")).length
  };
}

function timestampForRunId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function isoNow() {
  return new Date().toISOString();
}

function elapsedMs(startedAtMs) {
  return Date.now() - startedAtMs;
}

function countWords(text) {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function makeUnavailableTokenUsage() {
  return {
    reason: "Codex CLI exec output does not expose token usage for this run.",
    status: "unavailable"
  };
}

function buildRunManifest(workspaceRoot, config, rotation, archiveIndexing, options = {}) {
  const runId = options.runId ?? timestampForRunId();
  const now = options.now ?? new Date();
  const allowRules = buildCodexAllowRules(config);
  const managedLogs = config.managedLogs.map((entry) => entry.source);
  const allowedWritePaths = [
    ...[...allowRules.exactPaths].sort((left, right) => left.localeCompare(right)),
    ...allowRules.prefixPaths
  ];
  const protectedPaths = [
    ...config.protectedPaths.map(toPosixPath),
    ...config.managedLogs.map((logConfig) => toPosixPath(path.join(config.archiveRoot, logConfig.archiveKey)))
  ];

  return {
    archiveIndexing,
    codex: {
      model: config.codex.model,
      reasoningEffort: config.codex.reasoningEffort
    },
    generatedAt: now.toISOString(),
    managedLogs,
    managedLogPolicies: config.managedLogs.map((entry) => ({
      activeEntryLimit: getActiveEntryLimit(entry),
      archiveKey: entry.archiveKey,
      source: entry.source
    })),
    retentionDays: config.retentionDays,
    rotation,
    runId,
    stats: collectWorkspaceStats(workspaceRoot),
    summaryTargets: [
      `${toPosixPath(config.summariesRoot)}/${getQuarterInfo(now).year}/${getQuarterInfo(now).key}.md`
    ],
    allowedWritePaths,
    protectedPaths
  };
}

function renderRunReport(manifest, codexStatus, dryRun) {
  const lines = [
    "# Memory Maintenance Report",
    "",
    `- Run id: \`${manifest.runId}\``,
    `- Generated at: \`${manifest.generatedAt}\``,
    `- Mode: \`${dryRun ? "dry-run" : "apply"}\``,
    `- Codex status: \`${codexStatus.status}\``,
    ""
  ];

  if (manifest.performance) {
    lines.push("## Performance", "");
    lines.push(`- Total duration: ${manifest.performance.durationMs} ms`);

    if (manifest.performance.codex) {
      const codex = manifest.performance.codex;
      lines.push(`- Codex duration: ${codex.durationMs} ms`);
      lines.push(`- Codex model: \`${codex.model}\``);
      lines.push(`- Codex reasoning effort: \`${codex.reasoningEffort}\``);
      lines.push(`- Codex prompt size: ${codex.promptChars} chars, ${codex.promptWords} words`);
      lines.push(`- Codex output: \`${codex.outputMessagePath}\``);
      lines.push(`- Token usage: ${codex.tokenUsage.status}`);
      if (codex.tokenUsage.reason) {
        lines.push(`- Token usage note: ${codex.tokenUsage.reason}`);
      }
    }

    lines.push("");
  }

  lines.push("## Rotation", "");
  for (const entry of manifest.rotation) {
    const activeLimit = entry.activeEntryLimit === null ? "none" : entry.activeEntryLimit;
    lines.push(
      `- \`${entry.source}\`: rotated ${entry.rotatedCount}, cutoff ${entry.cutoffDate}, active entry limit ${activeLimit}`
    );
    for (const warning of entry.warnings) {
      lines.push(`- Warning: ${warning}`);
    }
  }

  lines.push("", "## Archive Indexes", "");
  for (const summary of manifest.archiveIndexing.summaries) {
    lines.push(
      `- \`${summary.archiveKey}\`: ${summary.archiveFileCount} archive files, ${summary.archivedEntryCount} archived entries`
    );
  }

  lines.push("", "## Codex", "");

  if (codexStatus.message) {
    lines.push(`- ${codexStatus.message}`);
  }

  if (Array.isArray(codexStatus.changedPaths) && codexStatus.changedPaths.length > 0) {
    lines.push(...codexStatus.changedPaths.map((changedPath) => `- Changed: \`${changedPath}\``));
  }

  if (Array.isArray(codexStatus.invalidPaths) && codexStatus.invalidPaths.length > 0) {
    lines.push(...codexStatus.invalidPaths.map((invalidPath) => `- Rejected out-of-scope change: \`${invalidPath}\``));
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeRunArtifacts(workspaceRoot, config, manifest, reportContent) {
  const maintenanceRoot = resolveWorkspacePath(workspaceRoot, config.maintenanceRoot);
  const runsDir = path.join(maintenanceRoot, "runs");
  const runJsonPath = path.join(runsDir, `${manifest.runId}.json`);
  const latestReportPath = path.join(maintenanceRoot, "latest-report.md");

  ensureDir(runsDir);
  safeWriteFile(runJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
  safeWriteFile(latestReportPath, reportContent);

  return {
    latestReportPath: toPosixPath(path.relative(workspaceRoot, latestReportPath)),
    runJsonPath: toPosixPath(path.relative(workspaceRoot, runJsonPath))
  };
}

function runCodexSynthesis(workspaceRoot, config, manifest, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const allowRules = buildCodexAllowRules(config);
  const startedAt = isoNow();
  const startedAtMs = Date.now();

  if (dryRun) {
    return {
      changedPaths: [],
      metrics: {
        durationMs: elapsedMs(startedAtMs),
        finishedAt: isoNow(),
        model: config.codex.model,
        outputMessagePath: null,
        promptChars: 0,
        promptWords: 0,
        reasoningEffort: config.codex.reasoningEffort,
        startedAt,
        tokenUsage: makeUnavailableTokenUsage()
      },
      message: "Dry-run: Codex synthesis skipped. Allowed targets were reported only.",
      status: "skipped"
    };
  }

  const codexBin = options.codexBin ?? process.env.DOCS_MAINTENANCE_CODEX_BIN ?? "codex";
  const resolvedCodexBin = codexBin.includes(path.sep) ? codexBin : spawnSync("bash", ["-lc", `command -v ${JSON.stringify(codexBin)}`], { encoding: "utf8" }).stdout.trim();

  if (!resolvedCodexBin) {
    throw new Error(`Codex binary not found: ${codexBin}`);
  }

  const tempRoot = createTempWorkspace(workspaceRoot, config, allowRules);
  const runJsonRelativePath = path.join(config.maintenanceRoot, "runs", `${manifest.runId}.json`);
  const prompt = buildCodexPrompt(config, manifest);
  const maintenanceRunPath = resolveWorkspacePath(tempRoot, runJsonRelativePath);
  const outputMessagePath = path.join(os.tmpdir(), `portable-agent-memory-codex-output-${manifest.runId}.txt`);
  const baseMetrics = {
    model: config.codex.model,
    outputMessagePath,
    promptChars: prompt.length,
    promptWords: countWords(prompt),
    reasoningEffort: config.codex.reasoningEffort,
    startedAt,
    tokenUsage: makeUnavailableTokenUsage()
  };

  safeWriteFile(maintenanceRunPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const initialSnapshot = snapshotFiles(tempRoot);

  const result = spawnSync(
    resolvedCodexBin,
    [
      "exec",
      "--skip-git-repo-check",
      "--full-auto",
      "--ephemeral",
      "-m",
      config.codex.model,
      "-c",
      `model_reasoning_effort="${config.codex.reasoningEffort}"`,
      "-C",
      tempRoot,
      "-o",
      outputMessagePath,
      prompt
    ],
    {
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    return {
      changedPaths: [],
      metrics: {
        ...baseMetrics,
        durationMs: elapsedMs(startedAtMs),
        finishedAt: isoNow()
      },
      message: `Codex exec failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
      status: "failed"
    };
  }

  const finalSnapshot = snapshotFiles(tempRoot);
  const changes = diffSnapshots(initialSnapshot, finalSnapshot);
  const validation = validateCodexChanges(changes, allowRules);

  if (validation.invalid.length > 0) {
    return {
      changedPaths: validation.valid.map((entry) => entry.path),
      invalidPaths: validation.invalid.map((entry) => entry.path),
      metrics: {
        ...baseMetrics,
        durationMs: elapsedMs(startedAtMs),
        finishedAt: isoNow()
      },
      message: "Codex produced out-of-scope changes. Copy-back was aborted.",
      status: "rejected"
    };
  }

  copyBackAllowedChanges(tempRoot, workspaceRoot, validation.valid);

  return {
    changedPaths: validation.valid.map((entry) => entry.path),
    metrics: {
      ...baseMetrics,
      durationMs: elapsedMs(startedAtMs),
      finishedAt: isoNow()
    },
    message: "Codex synthesis completed within the allowed write scope.",
    status: "applied"
  };
}

function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function runMaintenance(workspaceRoot, config, command, options = {}) {
  const startedAt = options.startedAt ?? isoNow();
  const startedAtMs = Date.now();
  const dryRun = Boolean(options.dryRun);
  let rotation = [];
  let archiveIndexing = { summaries: [], writes: [] };
  let codexStatus = {
    message: "Codex synthesis was not requested.",
    status: "skipped"
  };

  if (command === "rotate" || command === "maintain") {
    rotation = rotateManagedLogs(workspaceRoot, config, options);
  }

  if (command === "index" || command === "maintain") {
    archiveIndexing = regenerateArchiveIndexes(workspaceRoot, config, options);
  }

  const manifest = buildRunManifest(workspaceRoot, config, rotation, archiveIndexing, options);

  if (command === "codex" || command === "maintain") {
    codexStatus = runCodexSynthesis(workspaceRoot, config, manifest, options);
  }

  manifest.performance = {
    codex: codexStatus.metrics ?? null,
    durationMs: elapsedMs(startedAtMs),
    finishedAt: isoNow(),
    startedAt
  };

  const reportContent = renderRunReport(manifest, codexStatus, dryRun);
  const result = {
    archiveIndexing,
    codexStatus,
    dryRun,
    manifest,
    rotation
  };

  if (!dryRun) {
    result.artifacts = writeRunArtifacts(workspaceRoot, config, manifest, reportContent);
  }

  return result;
}

function parseCliArgs(argv) {
  const args = [...argv];
  const command = args[0] ?? "maintain";
  const flags = new Set(args.slice(1));

  return {
    command,
    dryRun: flags.has("--dry-run"),
    json: flags.has("--json")
  };
}

export {
  ARCHIVE_ENTRIES_MARKER,
  buildRunManifest,
  diffSnapshots,
  getArchiveRelativePath,
  getQuarterInfo,
  loadConfig,
  parseLogSections,
  regenerateArchiveIndexes,
  renderRunReport,
  rotateLogFile,
  rotateManagedLogs,
  runCodexSynthesis,
  runMaintenance,
  validateCodexChanges
};

function main() {
  const workspaceRoot = path.resolve(__dirname, "..");
  const { command, dryRun, json } = parseCliArgs(process.argv.slice(2));
  const config = loadConfig();

  if (!["rotate", "index", "codex", "maintain"].includes(command)) {
    throw new Error(`Unsupported memory-maintenance command: ${command}`);
  }

  const result = runMaintenance(workspaceRoot, config, command, { dryRun });

  if (json || dryRun) {
    printJson(result);
    return;
  }

  const reportPath = result.artifacts?.latestReportPath ?? path.join(config.maintenanceRoot, "latest-report.md");
  process.stdout.write(`Memory maintenance completed. Report: ${reportPath}\n`);
}

if (process.argv[1] === __filename) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
