import { z } from "zod";
import { CliError } from "./errors";

export const supportedRuntimePlatformSchema = z.enum(["darwin", "linux"]);
export type SupportedRuntimePlatform = z.output<typeof supportedRuntimePlatformSchema>;

export const SUPPORTED_RUNTIME_PLATFORMS = supportedRuntimePlatformSchema.options;

export function assertSupportedRuntimePlatform(
  platform: string = process.platform,
): SupportedRuntimePlatform {
  const parsed = supportedRuntimePlatformSchema.safeParse(platform);
  if (!parsed.success) {
    throw new CliError(
      "unsupported-platform",
      "This asana-cli release supports native macOS and Linux runtimes only.",
    );
  }
  return parsed.data;
}
