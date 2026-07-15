import { randomUUID } from "node:crypto";
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
  transitionOperationRecord,
  type CreateOperationInput,
  type OperationRecord,
  type OperationTransition,
} from "./schemas";

export type MemoryOperationRepositoryOptions = Readonly<{
  clock?: OperationClock;
  idGenerator?: OperationIdGenerator;
}>;

export class MemoryOperationRepository implements OperationRepository {
  readonly #clock: OperationClock;
  readonly #idGenerator: OperationIdGenerator;
  readonly #records = new Map<string, OperationRecord>();

  constructor(options: MemoryOperationRepositoryOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async create(input: CreateOperationInput): Promise<OperationRecord> {
    const id = z.uuid().parse(this.#idGenerator());
    if (this.#records.has(id)) {
      throw new OperationJournalError("ALREADY_EXISTS", `Operation ${id} already exists`);
    }
    const record = createOperationRecord(input, this.#clock(), id);
    this.#records.set(id, cloneOperationRecord(record));
    return cloneOperationRecord(record);
  }

  async get(idValue: string): Promise<OperationRecord | null> {
    const id = z.uuid().parse(idValue);
    const record = this.#records.get(id);
    if (!record) return null;
    const current = this.#expire(record);
    return cloneOperationRecord(current);
  }

  async compareAndSet(transitionValue: OperationTransition): Promise<OperationCompareAndSetResult> {
    const transition = operationTransitionSchema.parse(transitionValue);
    const stored = this.#records.get(transition.id);
    if (!stored) {
      throw new OperationJournalError("NOT_FOUND", `Operation ${transition.id} does not exist`);
    }
    const current = this.#expire(stored);
    if (current.state !== transition.expected_state) {
      return { updated: false, record: cloneOperationRecord(current) };
    }
    const changed = transitionOperationRecord(current, transition, this.#clock());
    this.#records.set(changed.id, cloneOperationRecord(changed));
    return { updated: true, record: cloneOperationRecord(changed) };
  }

  #expire(record: OperationRecord): OperationRecord {
    const now = this.#clock();
    if (!operationIsExpired(record, now)) return record;
    const expired = transitionOperationRecord(record, {
      id: record.id,
      expected_state: "prepared",
      next_state: "expired",
    }, now);
    this.#records.set(expired.id, cloneOperationRecord(expired));
    return expired;
  }
}
