import type {
  CreateOperationInput,
  OperationRecord,
  OperationTransition,
} from "./schemas";

export type OperationClock = () => Date;
export type OperationIdGenerator = () => string;

export type OperationCompareAndSetResult = Readonly<{
  updated: boolean;
  record: OperationRecord;
}>;

export interface OperationRepository {
  create(input: CreateOperationInput): Promise<OperationRecord>;
  get(id: string): Promise<OperationRecord | null>;
  inspect(id: string): Promise<OperationRecord | null>;
  compareAndSet(transition: OperationTransition): Promise<OperationCompareAndSetResult>;
}

export type OperationJournalErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "INVALID_RECORD"
  | "INSECURE_STORAGE"
  | "LOCKED"
  | "CORRUPT_LOCK"
  | "STORAGE_ERROR";

export class OperationJournalError extends Error {
  readonly code: OperationJournalErrorCode;

  constructor(code: OperationJournalErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OperationJournalError";
    this.code = code;
  }
}
