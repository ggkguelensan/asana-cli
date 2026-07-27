import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const distributionDirectory = resolve(projectRoot, "dist");

if (
  dirname(distributionDirectory) !== projectRoot ||
  basename(distributionDirectory) !== "dist"
) {
  throw new Error("Refusing to clean an unexpected distribution path");
}

await rm(distributionDirectory, { recursive: true, force: true });
process.stdout.write(`Removed ${distributionDirectory}\n`);
