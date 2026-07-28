import { z } from "zod";

export const dependencyMapSchema = z.record(z.string(), z.string());

export const bunLockBaseShape = {
  lockfileVersion: z.number().int().positive(),
  configVersion: z.number().int().positive(),
  overrides: dependencyMapSchema.optional(),
  workspaces: z.record(z.string(), z.looseObject({
    name: z.string().min(1),
    dependencies: dependencyMapSchema.optional(),
  })),
} as const;

function canonicalDependencyMap(value: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

export function verifyDependencyManifestProjection(
  packageManifest: Readonly<{
    name: string;
    dependencies: Readonly<Record<string, string>>;
    overrides?: Readonly<Record<string, string>>;
  }>,
  lockfile: Readonly<{
    overrides?: Readonly<Record<string, string>>;
    workspaces: Readonly<Record<string, Readonly<{
      name: string;
      dependencies?: Readonly<Record<string, string>>;
    }>>>;
  }>,
  messages: Readonly<{
    root: string;
    dependencies: string;
    overrides: string;
  }>,
): void {
  const root = lockfile.workspaces[""];
  if (!root || root.name !== packageManifest.name) {
    throw new Error(messages.root);
  }
  if (
    canonicalDependencyMap(root.dependencies ?? {}) !==
    canonicalDependencyMap(packageManifest.dependencies)
  ) {
    throw new Error(messages.dependencies);
  }
  if (
    canonicalDependencyMap(lockfile.overrides ?? {}) !==
    canonicalDependencyMap(packageManifest.overrides ?? {})
  ) {
    throw new Error(messages.overrides);
  }
}
