import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_HEARTBEAT_MS = 30 * 1000;

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertNoSymlinkPath(workspaceRoot, absolutePath, options = {}) {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(absolutePath);
  if (!isInside(root, target)) throw new Error(`path escapes workspace: ${absolutePath}`);
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stats;
    try {
      stats = fs.lstatSync(cursor);
    } catch (error) {
      if (error.code === "ENOENT" && options.allowMissing !== false) break;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`path contains symlink: ${path.relative(root, cursor)}`);
  }
  return target;
}

function readFileNoFollowSync(workspaceRoot, absolutePath, encoding = "utf8") {
  assertNoSymlinkPath(workspaceRoot, absolutePath, { allowMissing: false });
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(absolutePath, flags);
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) throw new Error(`path is not a regular file: ${absolutePath}`);
    return fs.readFileSync(fd, encoding);
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWriteFileSync(workspaceRoot, absolutePath, content, options = {}) {
  const target = assertNoSymlinkPath(workspaceRoot, absolutePath);
  const parent = path.dirname(target);
  assertNoSymlinkPath(workspaceRoot, parent);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertNoSymlinkPath(workspaceRoot, parent, { allowMissing: false });

  const realRoot = fs.realpathSync(workspaceRoot);
  const realParent = fs.realpathSync(parent);
  if (!isInside(realRoot, realParent)) throw new Error(`resolved parent escapes workspace: ${absolutePath}`);
  const realTarget = path.join(realParent, path.basename(target));
  if (!options.exclusive && fs.existsSync(realTarget)) {
    assertNoSymlinkPath(realRoot, realTarget, { allowMissing: false });
    const existing = fs.lstatSync(realTarget);
    if (!existing.isFile()) throw new Error(`target is not a regular file: ${absolutePath}`);
  }

  const temporary = path.join(realParent, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  const mode = options.mode ?? (!options.exclusive && fs.existsSync(realTarget) ? fs.statSync(realTarget).mode & 0o777 : 0o600);
  let fd;
  try {
    fd = fs.openSync(temporary, flags, mode);
    fs.writeFileSync(fd, content, { encoding: options.encoding ?? "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (options.exclusive) {
      try {
        fs.linkSync(temporary, realTarget);
      } catch (error) {
        if (error.code === "EEXIST") throw new Error(`target already exists: ${absolutePath}`);
        throw error;
      }
      fs.unlinkSync(temporary);
    } else {
      if (fs.existsSync(realTarget) && fs.lstatSync(realTarget).isSymbolicLink()) {
        throw new Error(`target path is a symlink: ${absolutePath}`);
      }
      fs.renameSync(temporary, realTarget);
    }
    const dirFd = fs.openSync(realParent, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.rmSync(temporary);
    } catch {}
    throw error;
  }
}

function lockOwnerMatches(actual, expected) {
  return actual?.version === 1
    && actual.pid === expected.pid
    && actual.host === expected.host
    && actual.nonce === expected.nonce;
}

function readLockSnapshot(workspaceRoot, absolutePath) {
  assertNoSymlinkPath(workspaceRoot, absolutePath, { allowMissing: false });
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(absolutePath, flags);
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) throw new Error(`lock path is not a regular file: ${absolutePath}`);
    let owner;
    try {
      owner = JSON.parse(fs.readFileSync(fd, "utf8"));
    } catch (error) {
      throw new Error(`lock owner is not valid JSON: ${error.message}`);
    }
    if (owner?.version !== 1
        || !Number.isInteger(owner?.pid) || owner.pid < 1
        || typeof owner?.host !== "string" || owner.host === ""
        || typeof owner?.nonce !== "string" || !/^[a-f0-9]{32,128}$/i.test(owner.nonce)
        || !Number.isFinite(Date.parse(owner?.acquiredAt))
        || !Number.isFinite(Date.parse(owner?.heartbeatAt))) {
      throw new Error("lock owner metadata is malformed");
    }
    return { owner, stats };
  } finally {
    fs.closeSync(fd);
  }
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function localProcessState(owner, host) {
  if (owner.host !== host) return "unknown";
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    return "unknown";
  }
}

function lockIsStale(snapshot, nowMs, staleMs) {
  const recordedHeartbeat = Date.parse(snapshot.owner.heartbeatAt);
  const lastHeartbeat = Math.max(recordedHeartbeat, snapshot.stats.mtimeMs);
  return nowMs - lastHeartbeat >= staleMs;
}

function writeLockOwner(fd, owner) {
  fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
  fs.fsyncSync(fd);
}

function cleanupRegularFile(absolutePath) {
  try {
    const stats = fs.lstatSync(absolutePath);
    if (stats.isFile()) fs.rmSync(absolutePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function restoreQuarantinedLock(quarantinePath, absolutePath) {
  try {
    fs.linkSync(quarantinePath, absolutePath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (fs.existsSync(absolutePath)) {
    cleanupRegularFile(quarantinePath);
  }
}

function acquireExclusiveLock(workspaceRoot, absolutePath, options = {}) {
  assertNoSymlinkPath(workspaceRoot, path.dirname(absolutePath), { allowMissing: false });
  const staleMs = Number.isFinite(options.staleMs) && options.staleMs >= 50
    ? options.staleMs
    : DEFAULT_LOCK_STALE_MS;
  const heartbeatMs = options.heartbeatMs === 0
    ? 0
    : (Number.isFinite(options.heartbeatMs) && options.heartbeatMs >= 10
        ? Math.min(options.heartbeatMs, Math.max(10, Math.floor(staleMs / 3)))
        : Math.min(DEFAULT_LOCK_HEARTBEAT_MS, Math.max(10, Math.floor(staleMs / 3))));
  const host = String(options.host || process.env.PAM_LOCK_HOST_ID || os.hostname());
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const acquiredAt = now().toISOString();
  const owner = {
    version: 1,
    pid: process.pid,
    host,
    nonce: crypto.randomBytes(24).toString("hex"),
    acquiredAt,
    heartbeatAt: acquiredAt
  };
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  let fd;
  let acquiredByTakeover = false;
  try {
    fd = fs.openSync(absolutePath, flags, 0o600);
    try {
      writeLockOwner(fd, owner);
    } catch (writeError) {
      fs.closeSync(fd);
      fd = undefined;
      cleanupRegularFile(absolutePath);
      throw writeError;
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    let observed;
    try {
      observed = readLockSnapshot(workspaceRoot, absolutePath);
    } catch (snapshotError) {
      throw new Error(`proposal is already being applied; existing lock is unverifiable: ${snapshotError.message}`);
    }
    const state = localProcessState(observed.owner, host);
    if (!lockIsStale(observed, now().getTime(), staleMs) || state !== "dead") {
      throw new Error("proposal is already being applied");
    }

    const candidatePath = `${absolutePath}.${owner.nonce}.candidate`;
    const quarantinePath = `${absolutePath}.${owner.nonce}.stale`;
    let candidateFd;
    try {
      candidateFd = fs.openSync(candidatePath, flags, 0o600);
      writeLockOwner(candidateFd, owner);
      fs.renameSync(absolutePath, quarantinePath);
      const quarantined = readLockSnapshot(workspaceRoot, quarantinePath);
      if (!sameInode(observed.stats, quarantined.stats)
          || !lockOwnerMatches(quarantined.owner, observed.owner)) {
        restoreQuarantinedLock(quarantinePath, absolutePath);
        throw new Error("proposal is already being applied; lock changed during stale takeover");
      }
      try {
        fs.linkSync(candidatePath, absolutePath);
      } catch (linkError) {
        if (linkError?.code === "EEXIST") {
          cleanupRegularFile(quarantinePath);
          throw new Error("proposal is already being applied");
        }
        restoreQuarantinedLock(quarantinePath, absolutePath);
        throw linkError;
      }
      try {
        cleanupRegularFile(candidatePath);
      } catch (candidateError) {
        cleanupRegularFile(absolutePath);
        restoreQuarantinedLock(quarantinePath, absolutePath);
        throw candidateError;
      }
      try {
        cleanupRegularFile(quarantinePath);
      } catch {}
      fd = candidateFd;
      candidateFd = undefined;
      acquiredByTakeover = true;
    } catch (takeoverError) {
      if (candidateFd !== undefined) fs.closeSync(candidateFd);
      cleanupRegularFile(candidatePath);
      if (fs.existsSync(quarantinePath) && !fs.existsSync(absolutePath)) {
        try {
          restoreQuarantinedLock(quarantinePath, absolutePath);
        } catch {}
      }
      throw takeoverError;
    }
  }

  const ownedStats = fs.fstatSync(fd);
  let released = false;
  let heartbeatTimer = null;

  function verifyOwnership() {
    let current;
    try {
      current = readLockSnapshot(workspaceRoot, absolutePath);
    } catch (error) {
      throw new Error(`lock ownership cannot be verified: ${error.message}`);
    }
    if (!sameInode(ownedStats, current.stats) || !lockOwnerMatches(current.owner, owner)) {
      throw new Error("lock ownership changed; refusing owner operation");
    }
  }

  function heartbeat() {
    if (released) return false;
    verifyOwnership();
    const heartbeatAt = now();
    fs.futimesSync(fd, heartbeatAt, heartbeatAt);
    return true;
  }

  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      try {
        heartbeat();
      } catch {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  return {
    owner: { ...owner },
    acquiredByTakeover,
    heartbeat,
    release() {
      if (released) return false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      try {
        verifyOwnership();
        fs.rmSync(absolutePath);
      } finally {
        released = true;
        fs.closeSync(fd);
      }
      return true;
    }
  };
}

function removeRegularFileNoFollowSync(workspaceRoot, absolutePath) {
  assertNoSymlinkPath(workspaceRoot, absolutePath, { allowMissing: false });
  const stats = fs.lstatSync(absolutePath);
  if (!stats.isFile()) throw new Error(`path is not a regular file: ${absolutePath}`);
  fs.rmSync(absolutePath);
}

export {
  acquireExclusiveLock,
  assertNoSymlinkPath,
  atomicWriteFileSync,
  readFileNoFollowSync,
  removeRegularFileNoFollowSync
};
