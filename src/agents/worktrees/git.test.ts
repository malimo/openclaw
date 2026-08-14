import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  findGitCheckoutRoot,
  hasSelfContainedGitMetadata,
  insideGitCheckout,
  requireGit,
  runGit,
} from "./git.js";

describe("Git checkout discovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("returns the nearest checkout root for nested paths", async () => {
    const root = tempDirs.make("openclaw-git-root-");
    const nested = path.join(root, "packages", "nested");
    await requireGit(root, ["init"]);
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
    const emptyTarget = path.join(root, "empty-target");
    const validTarget = path.join(root, "valid-target");
    await fs.mkdir(emptyTarget);
    await fs.mkdir(validTarget);
    await requireGit(validTarget, ["init", "--bare"]);

    await fs.writeFile(path.join(root, ".git"), "not-a-gitdir-pointer\n", "utf8");
    expect(findGitCheckoutRoot(root)).toBeNull();

    for (const malformed of [
      `junk\ngitdir: ${validTarget}\n`,
      `gitdir: ${validTarget}\njunk\n`,
      `GITDIR: ${validTarget}\n`,
      `gitdir:${validTarget}\n`,
    ]) {
      await fs.writeFile(path.join(root, ".git"), malformed, "utf8");
      expect(findGitCheckoutRoot(root)).toBeNull();
    }

    await fs.writeFile(path.join(root, ".git"), "gitdir: /missing/openclaw-worktree\n", "utf8");
    expect(findGitCheckoutRoot(root)).toBeNull();

    await fs.writeFile(path.join(root, ".git"), `gitdir: ${emptyTarget}\n`, "utf8");
    expect(findGitCheckoutRoot(root)).toBeNull();
    expect(insideGitCheckout(root)).toBe(false);
  });

  it("rejects an incomplete .git directory", async () => {
    const root = tempDirs.make("openclaw-incomplete-git-dir-");
    await fs.mkdir(path.join(root, ".git"));

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

  it("recognizes direct and linked reftable worktree checkouts", async () => {
    const root = tempDirs.make("openclaw-reftable-worktree-");
    const mainCheckout = path.join(root, "main");
    const linkedCheckout = path.join(root, "linked");
    await fs.mkdir(mainCheckout);
    await requireGit(mainCheckout, ["init", "--ref-format=reftable"]);
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

    expect(findGitCheckoutRoot(mainCheckout)).toBe(mainCheckout);
    expect(insideGitCheckout(mainCheckout)).toBe(true);

    await requireGit(mainCheckout, ["worktree", "add", "--detach", linkedCheckout, "HEAD"]);
    expect(findGitCheckoutRoot(linkedCheckout)).toBe(linkedCheckout);
    expect(insideGitCheckout(linkedCheckout)).toBe(true);

    await fs.rename(path.join(mainCheckout, ".git", "refs"), path.join(root, "saved-refs"));
    await expect(runGit(mainCheckout, ["rev-parse", "--show-toplevel"])).resolves.toMatchObject({
      code: 128,
    });
    await expect(runGit(linkedCheckout, ["rev-parse", "--show-toplevel"])).resolves.toMatchObject({
      code: 128,
    });
    expect(insideGitCheckout(mainCheckout)).toBe(false);
    expect(insideGitCheckout(linkedCheckout)).toBe(false);
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
