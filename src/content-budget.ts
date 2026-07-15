import { z } from "zod";

const MAX_REPORTED_TRUNCATED_PATHS = 100;
const encoder = new TextEncoder();

export const contentBudgetMetadataSchema = z.strictObject({
  max_bytes: z.number().int().nonnegative(),
  emitted_bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  truncated_values: z.number().int().nonnegative(),
  truncated_paths: z.array(z.string()).max(MAX_REPORTED_TRUNCATED_PATHS),
});

export type ContentBudgetMetadata = z.output<typeof contentBudgetMetadataSchema>;

function utf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export class ContentBudget {
  readonly #maximumBytes: number;
  #emittedBytes = 0;
  #truncatedValues = 0;
  readonly #truncatedPaths: string[] = [];

  constructor(maximumBytes: number) {
    this.#maximumBytes = maximumBytes;
  }

  take(value: string, path: string): string {
    const encodedBytes = encoder.encode(value).byteLength;
    const remainingBytes = Math.max(this.#maximumBytes - this.#emittedBytes, 0);
    if (encodedBytes <= remainingBytes) {
      this.#emittedBytes += encodedBytes;
      return value;
    }

    const prefix = utf8Prefix(value, remainingBytes);
    this.#emittedBytes += encoder.encode(prefix).byteLength;
    this.#truncatedValues += 1;
    if (this.#truncatedPaths.length < MAX_REPORTED_TRUNCATED_PATHS) {
      this.#truncatedPaths.push(path);
    }
    return prefix;
  }

  metadata(): ContentBudgetMetadata {
    return contentBudgetMetadataSchema.parse({
      max_bytes: this.#maximumBytes,
      emitted_bytes: this.#emittedBytes,
      truncated: this.#truncatedValues > 0,
      truncated_values: this.#truncatedValues,
      truncated_paths: this.#truncatedPaths,
    });
  }
}
