import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const installer = resolve(projectRoot, "install.sh");

describe("portable installer entrypoints", () => {
  test("ships valid POSIX shell with local help and strict version validation", async () => {
    const syntax = Bun.spawnSync(["sh", "-n", installer], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(syntax.exitCode).toBe(0);

    const help = Bun.spawnSync(["sh", installer, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(help.exitCode).toBe(0);
    expect(new TextDecoder().decode(help.stdout)).toContain("ASANA_CLI_INSTALL_DIR");

    const unsafe = Bun.spawnSync(["sh", installer, "--version", "../../unsafe"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(unsafe.exitCode).toBe(2);
  });

  test("documents standalone and Bun global installation", async () => {
    const readme = await Bun.file(resolve(projectRoot, "README.md")).text();
    expect(readme).toContain("install.sh | sh");
    expect(readme).toContain("bun add --global github:ggkguelensan/asana-cli");
  });
});
