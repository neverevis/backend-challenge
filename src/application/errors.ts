/**
 * Erros da camada de aplicação. Cada um corresponde a uma categoria que o
 * provedor precisa distinguir para decidir se reenvia (README seção 9).
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface FieldError {
  field: string;
  message: string;
}

/** Payload inválido. Corrigir antes de reenviar. */
export class ValidationError extends ApplicationError {
  readonly code = "VALIDATION_ERROR";

  constructor(public readonly details: FieldError[]) {
    super(details.map((d) => `${d.field}: ${d.message}`).join("; "));
  }
}

/** Mesma idempotency key (ou mesmo externalTransactionId) com payload diferente. */
export class IdempotencyConflictError extends ApplicationError {
  constructor(
    readonly code: "IDEMPOTENCY_KEY_CONFLICT" | "EXTERNAL_TRANSACTION_ID_CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";
}

export class NotFoundError extends ApplicationError {
  readonly code = "NOT_FOUND";
}

// ---- erros de infraestrutura, traduzidos pelo adaptador de banco

/** Falha temporária: o provedor pode reenviar com a mesma idempotency key. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code: string = "TRANSIENT_INFRASTRUCTURE_ERROR";
}

/** Não conseguiu o lock da wallet a tempo (hot wallet). */
export class LockTimeoutError extends TransientInfrastructureError {
  override readonly code = "LOCK_TIMEOUT";
}

/** Deadlock ou falha de serialização: seguro repetir a transação inteira. */
export class RetryableConflictError extends TransientInfrastructureError {
  override readonly code = "CONCURRENCY_CONFLICT";
}

/** Violação de UNIQUE. `constraint` identifica qual. */
export class UniqueViolationError extends ApplicationError {
  readonly code = "UNIQUE_VIOLATION";

  constructor(public readonly constraint: string | undefined) {
    super(`Unique constraint violated: ${constraint ?? "unknown"}`);
  }
}
