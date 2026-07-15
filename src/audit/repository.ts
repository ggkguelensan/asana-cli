import type { CreateMetadataAuditEventInput, MetadataAuditEvent } from "./schemas";

export type AuditClock = () => Date;
export type AuditEventIdGenerator = () => string;

export interface MetadataAuditStore {
  append(input: CreateMetadataAuditEventInput): Promise<MetadataAuditEvent>;
}

export type AuditStorageErrorCode =
  | "ALREADY_EXISTS"
  | "INVALID_EVENT"
  | "INSECURE_STORAGE"
  | "STORAGE_ERROR";

export class AuditStorageError extends Error {
  readonly code: AuditStorageErrorCode;

  constructor(code: AuditStorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditStorageError";
    this.code = code;
  }
}
