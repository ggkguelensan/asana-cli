import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("local binary installer", () => {
  test("installs an explicit executable into a directory containing spaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "asana-install-"));
    try {
      const binary = resolve(import.meta.dir, "../dist/asana-cli");
      const destination = join(root, "local bin");
      const child = Bun.spawn(["sh", "install.sh", "--binary", binary, "--bin-dir", destination], {
        cwd: resolve(import.meta.dir, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
      const installed = join(destination, "asana-cli");
      expect(await readFile(installed)).toEqual(await readFile(binary));
      expect((await stat(installed)).mode & 0o777).toBe(0o755);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("rejects relative destinations before installing", async () => {
    const child = Bun.spawn(["sh", "install.sh", "--binary", "/does/not/exist", "--bin-dir", "relative"], {
      cwd: resolve(import.meta.dir, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(2);
  });
});
