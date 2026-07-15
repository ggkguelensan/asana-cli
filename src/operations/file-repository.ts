import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type {
  OperationClock,
  OperationCompareAndSetResult,
  OperationIdGenerator,
  OperationRepository,
} from "./repository";
import { OperationJournalError } from "./repository";
import {
  cloneOperationRecord,
  createOperationRecord,
  operationIsExpired,
  operationTransitionSchema,
  parseOperationRecord,
  transitionOperationRecord,
  type CreateOperationInput,
  type OperationRecord,
  type OperationTransition,
} from "./schemas";
import {
  operationLockPath,
  operationRecordPath,
  resolveOperationJournalDirectory,
  type OperationPathPlatform,
} from "./paths";

const MAX_RECORD_BYTES = 1024 * 1024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const nodeErrorSchema = z.object({ code: z.string() });
const lockFileSchema = z.strictObject({
  file_format_version: z.literal(1),
  operation_id: z.uuid(),
  lock_id: z.uuid(),
  pid: z.number().int().nonnegative(),
  created_at: z.iso.datetime({ offset: true }),
});

type LockRecord = z.output<typeof lockFileSchema>;

export type FileOperationRepositoryOptions = Readonly<{
  baseDirectory?: string;
  environment?: Record<string, string | undefined>;
  platform?: OperationPathPlatform;
  clock?: OperationClock;
  idGenerator?: OperationIdGenerator;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}>;

function nodeErrorCode(error: unknown): string | undefined {
  const parsed = nodeErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}

function storageError(message: string, error: unknown): OperationJournalError {
  return new OperationJournalError("STORAGE_ERROR", message, { cause: error });
}

export class FileOperationRepository implements OperationRepository {
  readonly baseDirectory: string;
  readonly #clock: OperationClock;
  readonly #idGenerator: OperationIdGenerator;
  readonly #lockTimeoutMs: number;
  readonly #lockRetryMs: number;
  readonly #isPosix: boolean;

  constructor(options: FileOperationRepositoryOptions = {}) {
    const platform = options.platform ?? (process.platform === "win32"
      ? "win32"
      : process.platform === "darwin" ? "darwin" : "linux");
    this.baseDirectory = options.baseDirectory ?? resolveOperationJournalDirectory(
      options.environment,
      platform,
    );
    if (!isAbsolute(this.baseDirectory)) throw new Error("Operation journal base directory must be absolute");
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#lockTimeoutMs = z.number().int().nonnegative().max(30_000).parse(options.lockTimeoutMs ?? 1_000);
    this.#lockRetryMs = z.number().int().positive().max(1_000).parse(options.lockRetryMs ?? 10);
    this.#isPosix = platform !== "win32";
  }

  async create(input: CreateOperationInput): Promise<OperationRecord> {
    await this.#ensureDirectory();
    const id = z.uuid().parse(this.#idGenerator());
    return this.#withLock(id, async () => {
      const existing = await this.#readRecord(id);
      if (existing) {
        throw new OperationJournalError("ALREADY_EXISTS", `Operation ${id} already exists`);
      }
      const record = createOperationRecord(input, this.#clock(), id);
      await this.#writeRecord(record);
      return cloneOperationRecord(record);
    });
  }

  async get(idValue: string): Promise<OperationRecord | null> {
    await this.#ensureDirectory();
    const id = z.uuid().parse(idValue);
    const snapshot = await this.#readRecord(id);
    if (!snapshot || !operationIsExpired(snapshot, this.#clock())) {
      return snapshot ? cloneOperationRecord(snapshot) : null;
    }
    return this.#withLock(id, async () => {
      const record = await this.#readRecord(id);
      if (!record) return null;
      const current = await this.#expire(record);
      return cloneOperationRecord(current);
    });
  }

  async compareAndSet(transitionValue: OperationTransition): Promise<OperationCompareAndSetResult> {
    await this.#ensureDirectory();
    const transition = operationTransitionSchema.parse(transitionValue);
    return this.#withLock(transition.id, async () => {
      const stored = await this.#readRecord(transition.id);
      if (!stored) {
        throw new OperationJournalError("NOT_FOUND", `Operation ${transition.id} does not exist`);
      }
      const current = await this.#expire(stored);
      if (current.state !== transition.expected_state) {
        return { updated: false, record: cloneOperationRecord(current) };
      }
      const changed = transitionOperationRecord(current, transition, this.#clock());
      await this.#writeRecord(changed);
      return { updated: true, record: cloneOperationRecord(changed) };
    });
  }

  async #expire(record: OperationRecord): Promise<OperationRecord> {
    const now = this.#clock();
    if (!operationIsExpired(record, now)) return record;
    const expired = transitionOperationRecord(record, {
      id: record.id,
      expected_state: "prepared",
      next_state: "expired",
    }, now);
    await this.#writeRecord(expired);
    return expired;
  }

  async #ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.baseDirectory, { recursive: true, mode: DIRECTORY_MODE });
      const stats = await lstat(this.baseDirectory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new OperationJournalError("INSECURE_STORAGE", "Operation journal path is not a real directory");
      }
      this.#assertOwner(stats.uid, "Operation journal directory");
      if (this.#isPosix) await chmod(this.baseDirectory, DIRECTORY_MODE);
    } catch (error: unknown) {
      if (error instanceof OperationJournalError) throw error;
      throw storageError("Unable to initialize operation journal directory", error);
    }
  }

  #assertOwner(owner: number, label: string): void {
    if (!this.#isPosix || typeof process.getuid !== "function") return;
    if (owner !== process.getuid()) {
      throw new OperationJournalError("INSECURE_STORAGE", `${label} is owned by another user`);
    }
  }

  async #readRecord(id: string): Promise<OperationRecord | null> {
    const path = operationRecordPath(this.baseDirectory, id);
    let stats;
    try {
      stats = await lstat(path);
    } catch (error: unknown) {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw storageError(`Unable to inspect operation ${id}`, error);
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new OperationJournalError("INSECURE_STORAGE", `Operation ${id} is not a regular file`);
    }
    this.#assertOwner(stats.uid, `Operation ${id}`);
    if (this.#isPosix && (stats.mode & 0o077) !== 0) {
      throw new OperationJournalError("INSECURE_STORAGE", `Operation ${id} has insecure permissions`);
    }
    if (stats.size > MAX_RECORD_BYTES) {
      throw new OperationJournalError("INVALID_RECORD", `Operation ${id} exceeds the size limit`);
    }

    try {
      const text = await readFile(path, "utf8");
      const value: unknown = JSON.parse(text);
      const record = parseOperationRecord(value);
      if (record.id !== id) {
        throw new OperationJournalError("INVALID_RECORD", `Operation file ID does not match ${id}`);
      }
      return record;
    } catch (error: unknown) {
      if (error instanceof OperationJournalError) throw error;
      throw new OperationJournalError("INVALID_RECORD", `Operation ${id} is invalid or tampered`, {
        cause: error,
      });
    }
  }

  async #writeRecord(record: OperationRecord): Promise<void> {
    const path = operationRecordPath(this.baseDirectory, record.id);
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
      throw new OperationJournalError(
        "INVALID_RECORD",
        `Operation ${record.id} exceeds the size limit`,
      );
    }
    const temporary = join(dirname(path), `.${record.id}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, FILE_MODE);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (this.#isPosix) await chmod(temporary, FILE_MODE);
      await rename(temporary, path);
      if (this.#isPosix) await chmod(path, FILE_MODE);
      await this.#syncDirectory();
    } catch (error: unknown) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw storageError(`Unable to persist operation ${record.id}`, error);
    }
  }

  async #syncDirectory(): Promise<void> {
    if (!this.#isPosix) return;
    const directory = await open(this.baseDirectory, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async #withLock<Result>(id: string, action: () => Promise<Result>): Promise<Result> {
    const lock = await this.#acquireLock(id);
    try {
      return await action();
    } finally {
      await this.#releaseLock(lock);
    }
  }

  async #acquireLock(id: string): Promise<LockRecord> {
    const path = operationLockPath(this.baseDirectory, id);
    const deadline = Date.now() + this.#lockTimeoutMs;
    while (true) {
      const lock = lockFileSchema.parse({
        file_format_version: 1,
        operation_id: id,
        lock_id: randomUUID(),
        pid: process.pid,
        created_at: this.#clock().toISOString(),
      });
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let ownedIdentity: Readonly<{ dev: number; ino: number }> | undefined;
      try {
        handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, FILE_MODE);
        const stats = await handle.stat();
        ownedIdentity = { dev: stats.dev, ino: stats.ino };
        await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
        await handle.sync();
        if (this.#isPosix) await chmod(path, FILE_MODE);
        await handle.close();
        handle = undefined;
        return lock;
      } catch (error: unknown) {
        if (handle) {
          await handle.close().catch(() => undefined);
          handle = undefined;
        }
        if (ownedIdentity) {
          await this.#removeOwnedPartialLock(path, ownedIdentity);
        }
        if (nodeErrorCode(error) !== "EEXIST") {
          throw storageError(`Unable to lock operation ${id}`, error);
        }
        if (Date.now() >= deadline) {
          await this.#validateExistingLock(path, id);
          throw new OperationJournalError("LOCKED", `Operation ${id} is locked; refusing unsafe recovery`);
        }
        await Bun.sleep(this.#lockRetryMs);
      }
    }
  }

  async #removeOwnedPartialLock(
    path: string,
    identity: Readonly<{ dev: number; ino: number }>,
  ): Promise<void> {
    try {
      const current = await lstat(path);
      if (current.isSymbolicLink() || !current.isFile()) return;
      if (current.dev !== identity.dev || current.ino !== identity.ino) return;
      await rm(path);
    } catch (error: unknown) {
      if (nodeErrorCode(error) === "ENOENT") return;
      throw new OperationJournalError(
        "CORRUPT_LOCK",
        "Unable to remove a partial operation lock safely",
        { cause: error },
      );
    }
  }

  async #validateExistingLock(path: string, id: string): Promise<void> {
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("lock is not a regular file");
      this.#assertOwner(stats.uid, `Operation lock ${id}`);
      if (this.#isPosix && (stats.mode & 0o077) !== 0) throw new Error("lock permissions are insecure");
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      const lock = lockFileSchema.parse(value);
      if (lock.operation_id !== id) throw new Error("lock operation ID does not match");
    } catch (error: unknown) {
      if (error instanceof OperationJournalError) throw error;
      throw new OperationJournalError("CORRUPT_LOCK", `Operation ${id} has an invalid lock`, {
        cause: error,
      });
    }
  }

  async #releaseLock(lock: LockRecord): Promise<void> {
    const path = operationLockPath(this.baseDirectory, lock.operation_id);
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      const current = lockFileSchema.parse(value);
      if (current.lock_id !== lock.lock_id) {
        throw new OperationJournalError("CORRUPT_LOCK", "Operation lock changed while held");
      }
      await rm(path);
    } catch (error: unknown) {
      if (error instanceof OperationJournalError) throw error;
      throw new OperationJournalError("CORRUPT_LOCK", "Unable to safely release operation lock", {
        cause: error,
      });
    }
  }
}
