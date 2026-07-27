import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class TemporaryDirectories {
  readonly #directories: string[] = [];

  async create(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    this.#directories.push(directory);
    return directory;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.#directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })
      ),
    );
  }
}
