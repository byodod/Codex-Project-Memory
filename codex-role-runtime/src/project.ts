import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { ProjectContext } from "./types.js";
import { stableId } from "./util.js";

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}

export function resolveProject(input = process.cwd()): ProjectContext {
  let current = resolve(input);
  if (!existsSync(current)) throw new Error(`Working directory does not exist: ${current}`);
  current = realpathSync(current);
  const root = git(current, ["rev-parse", "--show-toplevel"]) ?? current;
  const commonRaw = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitCommonDir = commonRaw ? resolve(root, commonRaw) : null;
  const remote = git(root, ["config", "--get", "remote.origin.url"]);
  const identity = gitCommonDir || remote || root.toLowerCase();
  return {
    id: stableId(identity), root, name: basename(root) || basename(dirname(root)), remote, gitCommonDir,
    branch: git(root, ["branch", "--show-current"]), revision: git(root, ["rev-parse", "HEAD"])
  };
}
