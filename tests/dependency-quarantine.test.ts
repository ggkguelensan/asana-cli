import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const TWO_WEEKS_SECONDS = 14 * 24 * 60 * 60;

describe("dependency quarantine", () => {
  test("keeps Bun resolution behind a 14-day release-age gate", async () => {
    const bunfig = await readFile(resolve(root, "bunfig.toml"), "utf8");

    expect(bunfig).toContain(`minimumReleaseAge = ${TWO_WEEKS_SECONDS}`);
    expect(bunfig).not.toContain("minimumReleaseAgeExcludes");
  });

  test("keeps Dependabot version updates behind the same cooldown", async () => {
    const dependabot = await readFile(
      resolve(root, ".github", "dependabot.yml"),
      "utf8",
    );

    expect(dependabot).toContain('package-ecosystem: "bun"');
    expect(dependabot).toContain('package-ecosystem: "github-actions"');
    expect(dependabot.match(/default-days:\s*14/g)).toHaveLength(2);
  });

  test("keeps the documented security exception exact and reviewable", async () => {
    const packageManifest = await Bun.file(resolve(root, "package.json")).json();

    expect(packageManifest.overrides).toEqual({
      "brace-expansion": "5.0.8",
    });
  });
});
