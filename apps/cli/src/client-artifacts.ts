import { z } from "zod";
import {
  clientAdapter,
  clientAdapterSchema,
  type ClientAdapterId,
} from "./client-adapter-specs";

export const portableSkillRelativePathSchema = z
  .string()
  .regex(
    /^(?:SKILL\.md|references\/[a-z][a-z0-9-]*\.md)$/,
    "must be SKILL.md or a direct references/*.md file",
  );

export const portableSkillFileSchema = z.strictObject({
  path: portableSkillRelativePathSchema,
  content: z.union([z.string(), z.instanceof(Uint8Array)]),
});

export const portableSkillFilesSchema = z
  .array(portableSkillFileSchema)
  .min(1)
  .superRefine((files, context) => {
    const seen = new Set<string>();
    let hasSkill = false;

    for (const [index, file] of files.entries()) {
      if (seen.has(file.path)) {
        context.addIssue({
          code: "custom",
          path: [index, "path"],
          message: `duplicate portable skill path: ${file.path}`,
        });
      }
      seen.add(file.path);
      if (file.path === "SKILL.md") hasSkill = true;
    }

    if (!hasSkill) {
      context.addIssue({
        code: "custom",
        message: "portable skill files must include SKILL.md",
      });
    }
  });

export type PortableSkillFile = z.output<typeof portableSkillFileSchema>;
export type ClientArtifactContents = Record<string, Uint8Array>;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Converts canonical text to UTF-8 while retaining supplied bytes verbatim.
 * Decoding byte input first rejects malformed UTF-8 rather than silently
 * replacing it in a generated skill artifact.
 */
function normalizedUtf8Bytes(content: string | Uint8Array): Uint8Array {
  if (typeof content === "string") return utf8Encoder.encode(content);
  utf8Decoder.decode(content);
  return content;
}

/**
 * Builds one direct-discovery package from canonical portable skill files.
 * The adapter selection is intentionally metadata-only: every supported
 * client receives the same relative files and no adapter adds executable
 * configuration, MCP declarations, credentials, update, or marketplace data.
 */
export function buildClientArtifactContents(
  adapterId: ClientAdapterId,
  suppliedSkillFiles: readonly PortableSkillFile[],
): ClientArtifactContents {
  clientAdapter(adapterId);
  const sourceFiles = portableSkillFilesSchema.parse(suppliedSkillFiles);
  const contents: ClientArtifactContents = Object.create(null) as ClientArtifactContents;

  for (const file of [...sourceFiles].sort((left, right) => left.path.localeCompare(right.path))) {
    contents[file.path] = normalizedUtf8Bytes(file.content);
  }

  return contents;
}

export const clientArtifactPackageSchema = z.strictObject({
  adapter: clientAdapterSchema,
  files: z.record(portableSkillRelativePathSchema, z.instanceof(Uint8Array)),
});

export type ClientArtifactPackage = z.output<typeof clientArtifactPackageSchema>;

export function buildClientArtifactPackage(
  adapterId: ClientAdapterId,
  suppliedSkillFiles: readonly PortableSkillFile[],
): ClientArtifactPackage {
  const adapter = clientAdapter(adapterId);
  return clientArtifactPackageSchema.parse({
    adapter,
    files: buildClientArtifactContents(adapterId, suppliedSkillFiles),
  });
}
