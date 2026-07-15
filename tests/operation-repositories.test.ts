import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileOperationRepository } from "../src/operations/file-repository";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
import { operationLockPath, operationRecordPath } from "../src/operations/paths";

const operationId = "00000000-0000-4000-8000-000000000001";
const directories: string[] = [];

const input = {
  operation: "task.comment" as const,
  target: { task_gid: "987654" },
  payload: { text: "comment body belongs only to the immutable payload" },
  guards: {
    expected_modified_at: "2026-07-15T09:00:00.000Z",
    prepared_by_gid: "123456",
  },
  ttl_ms: 60_000,
};

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asana-operation-journal-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("memory operation repository", () => {
  test("allows only one prepared to applying compare-and-set", async () => {
    const repository = new MemoryOperationRepository({
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      idGenerator: () => operationId,
    });
    await repository.create(input);

    const transition = {
      id: operationId,
      expected_state: "prepared" as const,
      next_state: "applying" as const,
    };
    const results = await Promise.all([
      repository.compareAndSet(transition),
      repository.compareAndSet(transition),
    ]);

    expect(results.filter((result) => result.updated)).toHaveLength(1);
    expect(results.every((result) => result.record.state === "applying")).toBe(true);
  });

  test("expires a prepared record according to the injected clock", async () => {
    let now = new Date("2026-07-15T10:00:00.000Z");
    const repository = new MemoryOperationRepository({
      clock: () => now,
      idGenerator: () => operationId,
    });
    await repository.create({ ...input, ttl_ms: 1_000 });
    now = new Date("2026-07-15T10:00:01.000Z");

    const expired = await repository.get(operationId);
    expect(expired?.state).toBe("expired");
    expect(expired?.result?.outcome).toBe("expired");
  });

  test("does not let callers mutate stored target, payload, or guards", async () => {
    const repository = new MemoryOperationRepository({
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      idGenerator: () => operationId,
    });
    const outward = await repository.create(input);
    const target = outward.target as { task_gid: string };
    const payload = outward.payload as { text: string };
    const guards = outward.guards as { prepared_by_gid: string };
    target.task_gid = "1";
    payload.text = "mutated";
    guards.prepared_by_gid = "2";

    const stored = await repository.get(operationId);
    expect(stored?.target.task_gid).toBe("987654");
    expect(stored?.payload).toEqual(input.payload);
    expect(stored?.guards.prepared_by_gid).toBe("123456");
  });
});

describe("file operation repository", () => {
  test("uses restrictive permissions and leaves only a complete atomic record", async () => {
    const baseDirectory = join(await temporaryDirectory(), "nested", "operations");
    const repository = new FileOperationRepository({
      baseDirectory,
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      idGenerator: () => operationId,
    });
    const record = await repository.create(input);
    const loaded = await repository.get(record.id);

    expect(loaded).toEqual(record);
    expect(await readdir(baseDirectory)).toEqual([`${operationId}.json`]);
    if (process.platform !== "win32") {
      expect((await stat(baseDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(operationRecordPath(baseDirectory, operationId))).mode & 0o777).toBe(0o600);
    }
  });

  test("serializes concurrent CAS across repository instances so only one succeeds", async () => {
    const baseDirectory = await temporaryDirectory();
    const options = {
      baseDirectory,
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      lockTimeoutMs: 500,
      lockRetryMs: 2,
    };
    const first = new FileOperationRepository({ ...options, idGenerator: () => operationId });
    const second = new FileOperationRepository(options);
    await first.create(input);
    const transition = {
      id: operationId,
      expected_state: "prepared" as const,
      next_state: "applying" as const,
    };

    const results = await Promise.all([
      first.compareAndSet(transition),
      second.compareAndSet(transition),
    ]);
    expect(results.filter((result) => result.updated)).toHaveLength(1);
    expect((await first.get(operationId))?.state).toBe("applying");
    expect((await readdir(baseDirectory)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("rejects an oversized serialized record before a record or temp file appears", async () => {
    const baseDirectory = await temporaryDirectory();
    const repository = new FileOperationRepository({
      baseDirectory,
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      idGenerator: () => operationId,
    });
    const oversized = {
      ...input,
      operation: "task.update" as const,
      payload: { changes: { notes: "x".repeat(1_100_000) } },
    };

    await expect(repository.create(oversized)).rejects.toMatchObject({ code: "INVALID_RECORD" });
    expect(await readdir(baseDirectory)).toEqual([]);
  });

  test("removes only its partial lock when lock fsync fails after exclusive creation", async () => {
    const baseDirectory = await temporaryDirectory();
    const unrelated = join(baseDirectory, "unrelated.lock");
    await writeFile(unrelated, "do not remove", { mode: 0o600 });
    const probe = await open(join(baseDirectory, "probe"), "w");
    const prototype: object = Object.getPrototypeOf(probe);
    const syncDescriptor = Object.getOwnPropertyDescriptor(prototype, "sync");
    await probe.close();
    await rm(join(baseDirectory, "probe"));
    if (!syncDescriptor) throw new Error("FileHandle.sync descriptor is unavailable");
    Object.defineProperty(prototype, "sync", {
      ...syncDescriptor,
      value: async () => {
        throw new Error("injected fsync failure");
      },
    });

    try {
      const repository = new FileOperationRepository({
        baseDirectory,
        clock: () => new Date("2026-07-15T10:00:00.000Z"),
        idGenerator: () => operationId,
      });
      await expect(repository.create(input)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    } finally {
      Object.defineProperty(prototype, "sync", syncDescriptor);
    }

    expect(await readdir(baseDirectory)).toEqual(["unrelated.lock"]);
  });

  test("rejects a tampered record without returning its payload", async () => {
    const baseDirectory = await temporaryDirectory();
    const repository = new FileOperationRepository({
      baseDirectory,
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
      idGenerator: () => operationId,
    });
    await repository.create(input);
    const path = operationRecordPath(baseDirectory, operationId);
    const serialized = await readFile(path, "utf8");
    await writeFile(path, serialized.replace("comment body", "tampered body"), { mode: 0o600 });

    await expect(repository.get(operationId)).rejects.toMatchObject({ code: "INVALID_RECORD" });
  });

  test("rejects an unversioned foreign record", async () => {
    const baseDirectory = await temporaryDirectory();
    const repository = new FileOperationRepository({ baseDirectory, lockTimeoutMs: 20 });
    await repository.get(operationId);
    const path = operationRecordPath(baseDirectory, operationId);
    await writeFile(path, JSON.stringify({ id: operationId, state: "prepared" }), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(path, 0o600);

    await expect(repository.get(operationId)).rejects.toMatchObject({ code: "INVALID_RECORD" });
  });

  test("leaves a stale or crashed lock in place and fails closed", async () => {
    const baseDirectory = await temporaryDirectory();
    let now = new Date("2026-07-15T10:00:00.000Z");
    const repository = new FileOperationRepository({
      baseDirectory,
      clock: () => now,
      idGenerator: () => operationId,
      lockTimeoutMs: 20,
      lockRetryMs: 2,
    });
    await repository.create(input);
    const lockPath = operationLockPath(baseDirectory, operationId);
    await writeFile(lockPath, JSON.stringify({
      file_format_version: 1,
      operation_id: operationId,
      lock_id: "00000000-0000-4000-8000-000000000002",
      pid: 999_999,
      created_at: "2026-07-15T09:00:00.000Z",
    }), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(lockPath, 0o600);

    expect((await repository.get(operationId))?.state).toBe("prepared");
    await expect(repository.compareAndSet({
      id: operationId,
      expected_state: "prepared",
      next_state: "applying",
    })).rejects.toMatchObject({ code: "LOCKED" });
    now = new Date("2026-07-15T10:01:00.000Z");
    await expect(repository.get(operationId)).rejects.toMatchObject({ code: "LOCKED" });
    expect((await readdir(baseDirectory))).toContain(`${operationId}.lock`);
  });
});
