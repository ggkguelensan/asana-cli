import { CliError } from "./errors";
import { registerEnvironmentSecrets } from "./security";

export function hardenRuntime(): void {
  registerEnvironmentSecrets();
  process.env.BUN_CONFIG_VERBOSE_FETCH = "";
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new CliError(
      "Refusing to run with NODE_TLS_REJECT_UNAUTHORIZED=0 because it exposes the Asana credential to interception.",
      2,
    );
  }
}
