// Discovers git repository roots by walking ancestor directories.
import fs from "node:fs";
import path from "node:path";

const DEFAULT_GIT_DISCOVERY_MAX_DEPTH = 12;

function walkUpFrom<T>(
  startDir: string,
  opts: { maxDepth?: number },
  resolveAtDir: (dir: string) => T | null | undefined,
): T | null {
  let current = path.resolve(startDir);
  const maxDepth = opts.maxDepth ?? DEFAULT_GIT_DISCOVERY_MAX_DEPTH;
  for (let i = 0; i < maxDepth; i += 1) {
    const resolved = resolveAtDir(current);
    if (resolved !== null && resolved !== undefined) {
      return resolved;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function hasGitMarker(repoRoot: string): boolean {
  const gitPath = path.join(repoRoot, ".git");
  try {
    const stat = fs.statSync(gitPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

export function findGitRoot(startDir: string, opts: { maxDepth?: number } = {}): string | null {
  // A `.git` file counts as a repo marker even if it is not a valid gitdir pointer.
  return walkUpFrom(startDir, opts, (repoRoot) => (hasGitMarker(repoRoot) ? repoRoot : null));
}

export function resolveGitDirFromMarker(repoRoot: string): string | null {
  const gitPath = path.join(repoRoot, ".git");
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) {
      return gitPath;
    }
    if (!stat.isFile()) {
      return null;
    }
    const raw = fs.readFileSync(gitPath, "utf-8");
    const match = raw.match(/gitdir:\s*(.+)/i);
    if (!match?.[1]) {
      return null;
    }
    return path.resolve(repoRoot, match[1].trim());
  } catch {
    return null;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function hasValidGitHead(gitDir: string): boolean {
  const headPath = path.join(gitDir, "HEAD");
  try {
    const stat = fs.lstatSync(headPath);
    if (stat.isSymbolicLink()) {
      return fs.readlinkSync(headPath).startsWith("refs/");
    }
    if (!stat.isFile()) {
      return false;
    }
    const head = fs.readFileSync(headPath, "utf8").trim();
    return /^ref:\s*refs\/.+/u.test(head) || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(head);
  } catch {
    return false;
  }
}

function resolveGitCommonDir(gitDir: string): string | null {
  const marker = path.join(gitDir, "commondir");
  try {
    const commonDir = fs.readFileSync(marker, "utf8").trim();
    return commonDir ? path.resolve(gitDir, commonDir) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return gitDir;
    }
    return null;
  }
}

export function isValidGitDirectory(gitDir: string): boolean {
  if (!isDirectory(gitDir) || !hasValidGitHead(gitDir)) {
    return false;
  }
  const commonDir = resolveGitCommonDir(gitDir);
  return (
    commonDir !== null &&
    isDirectory(path.join(commonDir, "objects")) &&
    isDirectory(path.join(commonDir, "refs"))
  );
}

export function resolveGitHeadPath(
  startDir: string,
  opts: { maxDepth?: number } = {},
): string | null {
  // Stricter than findGitRoot: keep walking until a resolvable git dir is found.
  return walkUpFrom(startDir, opts, (repoRoot) => {
    const gitDir = resolveGitDirFromMarker(repoRoot);
    return gitDir ? path.join(gitDir, "HEAD") : null;
  });
}
