import { mkdir, copyFile, chmod } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await copyFile("apps/cli/dist/asana-cli", "dist/asana-cli");
await chmod("dist/asana-cli", 0o755);
