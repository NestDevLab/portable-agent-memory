import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..");

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const MIGRATION_RE = /^(\d+\.\d+\.\d+)-to-(\d+\.\d+\.\d+)-[a-z0-9][a-z0-9-]*\.md$/;
const DEFAULT_BASE_REF = "origin/main";

const MIGRATION_SENSITIVE_PATTERNS = [
  /^memory\/pam\.version\.json$/,
  /^memory\/agent-memory\//,
  /^memory\/graph\//,
  /^tools\//,
  /^docs\/openclaw-/,
  /^AGENT_BOOTSTRAP\.md$/,
  /^AGENTS\.md$/,
  /^\.claude-plugin\//,
  /^\.claude\//,
  /^hooks\//,
  /^package\.json$/
];

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function compareSemver(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return 0;
}

function incrementIsValid(from, to) {
  const a = from.split(".").map(Number);
  const b = to.split(".").map(Number);
  if (b[0] === a[0] && b[1] === a[1] && b[2] === a[2] + 1) {
    return true;
  }
  if (b[0] === a[0] && b[1] === a[1] + 1 && b[2] === 0) {
    return true;
  }
  if (b[0] === a[0] + 1 && b[1] === 0 && b[2] === 0) {
    return true;
  }
  return false;
}

function listMigrationFiles(root) {
  const migrationDir = path.join(root, "migrations");
  if (!fs.existsSync(migrationDir)) {
    return [];
  }
  return fs.readdirSync(migrationDir).filter((name) => name.endsWith(".md")).sort();
}

function parseSemverMigrations(files) {
  return files.flatMap((name) => {
    const match = MIGRATION_RE.exec(name);
    if (!match) {
      return [];
    }
    return [{ name, from: match[1], to: match[2] }];
  });
}

function getJsonAtRef(root, ref, relativePath) {
  try {
    const content = execFileSync("git", ["show", `${ref}:${relativePath}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function listChangedFiles(root, baseRef) {
  try {
    const mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const output = execFileSync("git", ["diff", "--name-only", `${mergeBase}...HEAD`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const worktreeOutput = execFileSync("git", ["diff", "--name-only", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const untrackedOutput = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return [
      ...new Set(`${output}\n${worktreeOutput}\n${untrackedOutput}`.split("\n").map((line) => line.trim()).filter(Boolean))
    ];
  } catch {
    return [];
  }
}

function isMigrationSensitive(relativePath) {
  if (relativePath.startsWith("migrations/")) {
    return false;
  }
  if (relativePath === "CHANGELOG.md" || relativePath === "README.md") {
    return false;
  }
  return MIGRATION_SENSITIVE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function buildMigrationPath(migrations, fromVersion, toVersion) {
  const byFrom = new Map();
  for (const migration of migrations) {
    if (!byFrom.has(migration.from)) {
      byFrom.set(migration.from, []);
    }
    byFrom.get(migration.from).push(migration);
  }

  const pathItems = [];
  let current = fromVersion;
  const seen = new Set();
  while (compareSemver(current, toVersion) < 0) {
    if (seen.has(current)) {
      return null;
    }
    seen.add(current);
    const next = (byFrom.get(current) ?? [])
      .filter((migration) => compareSemver(migration.to, current) > 0)
      .sort((a, b) => compareSemver(a.to, b.to))[0];
    if (!next || compareSemver(next.to, toVersion) > 0) {
      return null;
    }
    pathItems.push(next);
    current = next.to;
  }
  return current === toVersion ? pathItems : null;
}

function checkMigrations(root = WORKSPACE_ROOT, options = {}) {
  const baseRef = options.baseRef ?? process.env.PAM_MIGRATIONS_BASE_REF ?? DEFAULT_BASE_REF;
  const packageJson = readJson(root, "package.json");
  const pamVersion = readJson(root, "memory/pam.version.json");
  const files = listMigrationFiles(root);
  const migrations = parseSemverMigrations(files);
  const changedFiles = options.changedFiles ?? listChangedFiles(root, baseRef);
  const basePackage = options.basePackage ?? getJsonAtRef(root, baseRef, "package.json");
  const basePamVersion = options.basePamVersion ?? getJsonAtRef(root, baseRef, "memory/pam.version.json");
  const errors = [];
  const warnings = [];

  if (!SEMVER_RE.test(packageJson.version)) {
    errors.push(`package.json version is not semver: ${packageJson.version}`);
  }
  if (!SEMVER_RE.test(pamVersion.pamVersion)) {
    errors.push(`memory/pam.version.json pamVersion is not semver: ${pamVersion.pamVersion}`);
  }
  if (packageJson.version !== pamVersion.pamVersion) {
    errors.push(`package.json version (${packageJson.version}) must match pamVersion (${pamVersion.pamVersion})`);
  }

  for (const name of files) {
    if (/^\d+\.\d+\.\d+-to-/.test(name) && !MIGRATION_RE.test(name)) {
      errors.push(`migration filename is invalid: migrations/${name}`);
    }
  }

  const targetVersions = new Map();
  for (const migration of migrations) {
    if (!incrementIsValid(migration.from, migration.to)) {
      errors.push(`migration skips a semver step: migrations/${migration.name}`);
    }
    const previous = targetVersions.get(migration.to);
    if (previous) {
      errors.push(`multiple migrations target ${migration.to}: migrations/${previous}, migrations/${migration.name}`);
    } else {
      targetVersions.set(migration.to, migration.name);
    }
    if (compareSemver(migration.to, pamVersion.pamVersion) > 0) {
      errors.push(`migration targets future version ${migration.to}: migrations/${migration.name}`);
    }
  }

  const baseVersion = basePamVersion?.pamVersion ?? basePackage?.version ?? null;
  const versionChanged = Boolean(baseVersion && baseVersion !== pamVersion.pamVersion);
  const sensitiveChanges = changedFiles.filter(isMigrationSensitive);

  if (sensitiveChanges.length > 0 && !versionChanged) {
    errors.push(
      `migration-sensitive files changed without a PAM version bump from ${baseRef}: ${sensitiveChanges.join(", ")}`
    );
  }

  if (versionChanged) {
    const pathItems = buildMigrationPath(migrations, baseVersion, pamVersion.pamVersion);
    if (!pathItems) {
      errors.push(`missing contiguous migration path from ${baseVersion} to ${pamVersion.pamVersion}`);
    }
  } else if (changedFiles.length === 0) {
    warnings.push("no git diff against base ref; only repository consistency was checked");
  }

  return {
    ok: errors.length === 0,
    baseRef,
    currentVersion: pamVersion.pamVersion,
    baseVersion,
    changedFiles,
    sensitiveChanges,
    migrations,
    errors,
    warnings
  };
}

export {
  MIGRATION_SENSITIVE_PATTERNS,
  buildMigrationPath,
  checkMigrations,
  compareSemver,
  incrementIsValid,
  isMigrationSensitive,
  parseSemverMigrations
};

function main() {
  const result = checkMigrations();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`migration check OK for PAM ${result.currentVersion}\n`);
    for (const warning of result.warnings) {
      process.stdout.write(`WARN: ${warning}\n`);
    }
  } else {
    process.stderr.write("migration check failed:\n");
    for (const error of result.errors) {
      process.stderr.write(`- ${error}\n`);
    }
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === __filename) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
