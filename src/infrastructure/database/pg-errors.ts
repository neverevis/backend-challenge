import {
  LockTimeoutError,
  RetryableConflictError,
  TransientInfrastructureError,
  UniqueViolationError,
} from "../../application/errors";

interface PgLikeError {
  code?: string;
  constraint?: string;
  message?: string;
}

/** Códigos SQLSTATE relevantes. */
const UNIQUE_VIOLATION = "23505";
const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_DETECTED = "40P01";
const LOCK_NOT_AVAILABLE = "55P03";
const QUERY_CANCELED = "57014"; // statement_timeout
const CONNECTION_CLASS = "08"; // 08xxx: falhas de conexão
const ADMIN_SHUTDOWN = "57P01";
const CANNOT_CONNECT_NOW = "57P03";

const NETWORK_ERRORS = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND"]);

/**
 * Traduz erros do driver para os erros da aplicação. Assim o use case
 * decide o que fazer (replay, retry, 503) sem conhecer o Postgres.
 */
export function translateDbError(e: unknown): unknown {
  const err = e as PgLikeError;
  const code = err?.code;
  if (!code) return e;

  if (code === UNIQUE_VIOLATION) return new UniqueViolationError(err.constraint);
  if (code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED) {
    return new RetryableConflictError(err.message ?? "Concurrency conflict");
  }
  if (code === LOCK_NOT_AVAILABLE) return new LockTimeoutError("Timed out waiting for wallet lock");
  if (
    code === QUERY_CANCELED ||
    code.startsWith(CONNECTION_CLASS) ||
    code === ADMIN_SHUTDOWN ||
    code === CANNOT_CONNECT_NOW ||
    NETWORK_ERRORS.has(code)
  ) {
    return new TransientInfrastructureError(`Database unavailable (${code})`);
  }
  return e;
}

/** Timestamps chegam como string ("2026-11-12 14:05:38.742958+00"). */
export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value !== "string") throw new Error(`Invalid timestamp: ${String(value)}`);
  const iso = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date;
}

export function toOptionalDate(value: unknown): Date | undefined {
  return value === null || value === undefined ? undefined : toDate(value);
}
