import { execFileSync } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { ProjectContext } from "./types.js";
import { sha256 } from "./util.js";

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 3000
    }).trim() || null;
  } catch {
    return null;
  }
}

function normalizedPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function resolveProject(cwdInput?: string): ProjectContext {
  const cwd = normalizedPath(cwdInput || process.cwd());
  const topLevel = git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = normalizedPath(topLevel || cwd);
  const commonRaw = git(root, ["rev-parse", "--git-common-dir"]);
  const gitCommonDir = commonRaw
    ? normalizedPath(isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw))
    : null;
  const remote = git(root, ["config", "--get", "remote.origin.url"]);
  const branch = git(root, ["branch", "--show-current"]);
  const revision = git(root, ["rev-parse", "HEAD"]);
  const identity = remote
    ? `remote:${remote.toLowerCase()}|common:${gitCommonDir ?? root}`
    : `path:${gitCommonDir ?? root}`;
  return {
    id: sha256(identity).slice(0, 24),
    root,
    name: basename(root),
    remote,
    gitCommonDir,
    branch,
    revision
  };
}
