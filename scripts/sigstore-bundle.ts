import { readFile } from "node:fs/promises";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const signatureSchema = z.strictObject({
  sig: z.string().min(16),
  keyid: z.string().optional(),
});
const bundleSchema = z.looseObject({
  mediaType: z.string().regex(
    /^application\/vnd\.dev\.sigstore\.bundle\.v\d+\.\d+\+json$/,
  ),
  verificationMaterial: z.record(z.string(), z.unknown()),
  dsseEnvelope: z.strictObject({
    payloadType: z.literal("application/vnd.in-toto+json"),
    payload: z.string().min(16),
    signatures: z.array(signatureSchema).min(1),
  }),
});
const statementSchema = z.looseObject({
  _type: z.literal("https://in-toto.io/Statement/v1"),
  subject: z.array(z.strictObject({
    name: z.string().min(1),
    digest: z.strictObject({
      sha256: sha256Schema,
    }),
  })).min(1),
  predicateType: z.string().url(),
  predicate: z.unknown(),
});

export const BUILD_PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
export const SPDX_SBOM_PREDICATE = "https://spdx.dev/Document/v2.3";

export type AttestationSubject = Readonly<{
  name: string;
  sha256: string;
  predicateType: typeof BUILD_PROVENANCE_PREDICATE | typeof SPDX_SBOM_PREDICATE;
}>;

export function parseSigstoreBundle(
  value: unknown,
  expected: AttestationSubject,
): void {
  const bundle = bundleSchema.parse(value);
  let decoded: string;
  try {
    decoded = Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8");
  } catch {
    throw new Error("Sigstore bundle contains an invalid DSSE payload");
  }
  let statementValue: unknown;
  try {
    statementValue = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error("Sigstore bundle DSSE payload is not JSON");
  }
  const statement = statementSchema.parse(statementValue);
  if (statement.predicateType !== expected.predicateType) {
    throw new Error(`Sigstore bundle has unexpected predicate ${statement.predicateType}`);
  }
  if (
    statement.subject.length !== 1 ||
    statement.subject[0]?.name !== expected.name ||
    statement.subject[0]?.digest.sha256 !== sha256Schema.parse(expected.sha256)
  ) {
    throw new Error("Sigstore bundle subject does not match the release artifact");
  }
}

export async function verifySigstoreBundle(
  path: string,
  expected: AttestationSubject,
): Promise<void> {
  const bytes = await readFile(path);
  if (bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error("Sigstore bundle exceeds the 4 MiB release bound");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Sigstore bundle is not JSON");
  }
  parseSigstoreBundle(value, expected);
}
