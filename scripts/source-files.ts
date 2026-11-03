import { resolve } from "node:path";

/** Include staged and untracked source; exclude dependencies, caches and build artifacts. */
export async function projectFiles(): Promise<string[]> {
  const child = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`Cannot inspect project sources: ${error}`);
  return [...new Set(output.split("\0").filter(Boolean))];
}
