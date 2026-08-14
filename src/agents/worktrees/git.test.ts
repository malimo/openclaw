import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  findGitCheckoutRoot,
  hasSelfContainedGitMetadata,
  insideGitCheckout,
  requireGit,
} from "./git.js";

describe("Git checkout discovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("returns the nearest checkout root for nested paths", async () => {
    const root = tempDirs.make("openclaw-git-root-");
    const nested = path.join(root, "packages", "nested");
    await fs.mkdir(path.join(root, ".git"));
    await fs.mkdir(nested, { recursive: true });

    expect(findGitCheckoutRoot(nested)).toBe(root);
    expect(insideGitCheckout(nested)).toBe(true);
  });

  it("returns null outside a checkout", async () => {
    const root = tempDirs.make("openclaw-no-git-root-");

    expect(findGitCheckoutRoot(root)).toBeNull();
    expect(insideGitCheckout(root)).toBe(false);
  });

  it("rejects malformed and stale linked checkout pointers", async () => {
    const root = tempDirs.make("openclaw-invalid-git-pointer-");

    await fs.writeFile(path.join(root, ".git"), "not-a-gitdir-pointer\n", "utf8");
    expect(findGitCheckoutRoot(root)).toBeNull();

    await fs.writeFile(path.join(root, ".git"), "gitdir: /missing/openclaw-worktree\n", "utf8");
    expect(findGitCheckoutRoot(root)).toBeNull();
    expect(insideGitCheckout(root)).toBe(false);
  });

  it("recognizes a real linked worktree checkout", async () => {
    const root = tempDirs.make("openclaw-linked-worktree-");
    const mainCheckout = path.join(root, "main");
    const linkedCheckout = path.join(root, "linked");
    await fs.mkdir(mainCheckout);
    await requireGit(mainCheckout, ["init"]);
    await requireGit(mainCheckout, [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=openclaw-test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    await requireGit(mainCheckout, ["worktree", "add", "--detach", linkedCheckout, "HEAD"]);

    expect(findGitCheckoutRoot(linkedCheckout)).toBe(linkedCheckout);
    expect(insideGitCheckout(linkedCheckout)).toBe(true);
  });

  it("distinguishes contained metadata from linked checkout pointers", async () => {
    const root = tempDirs.make("openclaw-git-metadata-");
    await fs.mkdir(path.join(root, ".git"));
    await expect(hasSelfContainedGitMetadata(root)).resolves.toBe(true);

    await fs.rm(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git"), "gitdir: /outside/worktrees/card\n", "utf8");
    await expect(hasSelfContainedGitMetadata(root)).resolves.toBe(false);
  });
});
