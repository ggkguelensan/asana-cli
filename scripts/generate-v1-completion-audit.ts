import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildV1CompletionAudit,
  renderV1CompletionAudit,
} from "./v1-completion-audit";

const outputPath = resolve(import.meta.dir, "../evidence/v1/completion-audit.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderV1CompletionAudit(await buildV1CompletionAudit()));
process.stdout.write("Generated evidence/v1/completion-audit.json\n");
