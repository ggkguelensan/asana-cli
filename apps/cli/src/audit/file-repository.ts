import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { auditEventPath, resolveAuditLogDirectory, type AuditPathPlatform } from "./paths";
import { assertSupportedRuntimePlatform } from "../platform-support";
import {
  AuditStorageError,
  type AuditClock,
  type AuditEventIdGenerator,
  type MetadataAuditStore,
} from "./repository";
import {
  cloneMetadataAuditEvent,
  createMetadataAuditEvent,
  type CreateMetadataAuditEventInput,
  type MetadataAuditEvent,
} from "./schemas";

const MAX_AUDIT_EVENT_BYTES = 16 * 1_024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const nodeErrorSchema = z.object({ code: z.string() });

export type FileMetadataAuditStoreOptions = Readonly<{
  baseDirectory?: string;
  environment?: Record<string, string | undefined>;
  platform?: AuditPathPlatform;
  clock?: AuditClock;
  eventIdGenerator?: AuditEventIdGenerator;
}>;

export class FileMetadataAuditStore implements MetadataAuditStore {
  readonly baseDirectory: string;
  readonly #clock: AuditClock;
  readonly #eventIdGenerator: AuditEventIdGenerator;

  constructor(options: FileMetadataAuditStoreOptions = {}) {
    const platform = options.platform ?? assertSupportedRuntimePlatform();
    this.baseDirectory = options.baseDirectory ?? resolveAuditLogDirectory(options.environment, platform);
    if (!isAbsolute(this.baseDirectory)) throw new Error("Audit log base directory must be absolute");
    this.#clock = options.clock ?? (() => new Date());
    this.#eventIdGenerator = options.eventIdGenerator ?? randomUUID;
  }

  async append(input: CreateMetadataAuditEventInput): Promise<MetadataAuditEvent> {
    await this.#ensureDirectory();
    const event = createMetadataAuditEvent(input, this.#clock(), this.#eventIdGenerator());
    await this.#writeEvent(event);
    return cloneMetadataAuditEvent(event);
  }

  async #ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.baseDirectory, { recursive: true, mode: DIRECTORY_MODE });
      const stats = await lstat(this.baseDirectory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new AuditStorageError("INSECURE_STORAGE", "Audit log path is not a real directory");
      }
      this.#assertOwner(stats.uid, "Audit log directory");
      await chmod(this.baseDirectory, DIRECTORY_MODE);
    } catch (error: unknown) {
      if (error instanceof AuditStorageError) throw error;
      throw new AuditStorageError("STORAGE_ERROR", "Unable to initialize audit log directory", { cause: error });
    }
  }

  #assertOwner(owner: number, label: string): void {
    if (typeof process.getuid !== "function") {
      throw new AuditStorageError(
        "INSECURE_STORAGE",
        "Current user cannot be determined for audit log ownership checks",
      );
    }
    if (owner !== process.getuid()) {
      throw new AuditStorageError("INSECURE_STORAGE", `${label} is owned by another user`);
    }
  }

  async #writeEvent(event: MetadataAuditEvent): Promise<void> {
    const path = auditEventPath(this.baseDirectory, event.event_id);
    const serialized = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_AUDIT_EVENT_BYTES) {
      throw new AuditStorageError("INVALID_EVENT", `Audit event ${event.event_id} exceeds the size limit`);
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, FILE_MODE);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await chmod(path, FILE_MODE);
      await handle.close();
      handle = undefined;
      await this.#syncDirectory();
    } catch (error: unknown) {
      if (handle) await handle.close().catch(() => undefined);
      const nodeError = nodeErrorSchema.safeParse(error);
      if (nodeError.success && nodeError.data.code === "EEXIST") {
        throw new AuditStorageError("ALREADY_EXISTS", `Audit event ${event.event_id} already exists`, { cause: error });
      }
      if (error instanceof AuditStorageError) throw error;
      throw new AuditStorageError("STORAGE_ERROR", `Unable to persist audit event ${event.event_id}`, {
        cause: error,
      });
    }
  }

  async #syncDirectory(): Promise<void> {
    const directory = await open(this.baseDirectory, constants.O_RDONLY);
    try {
      await directory.sync();
    } catch (error: unknown) {
      throw new AuditStorageError("STORAGE_ERROR", "Unable to synchronize audit log directory", {
        cause: error,
      });
    } finally {
      await directory.close();
    }
  }
}
