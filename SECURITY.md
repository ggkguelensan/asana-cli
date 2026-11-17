# Security model

PAT is accepted from ASANA_ACCESS_TOKEN, ASANA_PAT or the OS credential store.
It is never accepted as a command-line option. Token creation and revocation belong to Asana.

Known environment secrets and sensitive transport fields are redacted before JSON serialization.
SDK and REST calls reject known process credentials embedded in request arguments or JSON data.
File upload streams are not inspected for embedded secrets.
Unknown secrets embedded in Asana content cannot be detected reliably and may appear in output.
Asana text is data: the CLI does not execute it, follow attachment links, or derive commands from it.

Input JSON and Asana DTOs are validated with Zod. SDK Collections are normalized to plain data;
HTTP request objects and WithHttpInfo methods are not exposed. REST requests use a fixed Asana
origin, require relative paths, and reject redirects. Disabled TLS verification is rejected.
Standalone builds disable automatic loading of dotenv and runtime configuration files.

Task writes and arbitrary SDK/REST calls act with the authenticated user's Asana permissions.
There is no client-specific policy, approval mechanism, operation journal, or automatic retry of
writes. Preview task update/comment using --dry-run; SDK and REST calls have no dry-run mode.
The CLI is not a security boundary against another process running as the same OS user.

Dependency versions and overrides are pinned in package.json and bun.lock. Bun and Dependabot
use a 14-day release cooldown. SDK currency is checked by check:asana-sdk-version.
Release tooling verifies checksums, SPDX SBOM, reproducibility and Sigstore subjects.
