import { CliError } from "./errors";
import { registerEnvironmentSecrets } from "./security";
import { z } from "zod";

const runtimeEnvironmentSchema = z.object({
  NODE_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
});

export function hardenRuntime({ registerSecrets = true }: { registerSecrets?: boolean } = {}): void {
  if (registerSecrets) registerEnvironmentSecrets();
  process.env.BUN_CONFIG_VERBOSE_FETCH = "";
  const environment = runtimeEnvironmentSchema.parse(process.env);
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new CliError(
      "policy-denied",
      "Refusing to run with NODE_TLS_REJECT_UNAUTHORIZED=0 because it exposes the Asana credential to interception.",
    );
  }
}
