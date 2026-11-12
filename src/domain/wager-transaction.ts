import { InvalidTransactionStateError, InvalidWagerTransactionError } from "./errors";
import { FailureCode } from "./failure-code";
import { Money } from "./money";
import { LedgerDirection } from "./wallet-ledger-entry";

export enum WagerTransactionKind {
  Opening = "OPENING", // interno: crédito de abertura da wallet
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING", // aceita, ainda não aplicada
  PendingReference = "PENDING_REFERENCE", // aguardando a transação referenciada
  Processed = "PROCESSED", // aplicada (terminal)
  Rejected = "REJECTED", // violação de regra de negócio (terminal)
  Failed = "FAILED", // erro permanente de infraestrutura (terminal, auditável)
}

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Tipos que o provedor pode submeter (OPENING é interno). */
export const EXTERNAL_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

/**
 * Política de reprocessamento de referência ausente (README 7.1):
 * backoff exponencial 1s, 2s, 4s ... limitado a 60s, no máximo 10 tentativas
 * (~5 min de janela total). Ver justificativa no ARCHITECTURE.md.
 */
export const REFERENCE_RETRY_POLICY = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: 10,
} as const;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Saldo observado quando a transação chegou ao estado atual (para replay). */
  resultBalance?: Money;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date;
}

/**
 * Transições válidas:
 *
 *   PENDING ──────────▶ PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE ▶ PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
 *   PROCESSED, REJECTED, FAILED: terminais — qualquer transição lança erro.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceCheckAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. Valida a forma exigida por kind. Só para tipos externos. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("OPENING is internal and cannot be submitted");
    }
    WagerTransaction.validate(props);
    return WagerTransaction.fresh(props);
  }

  /** Transação interna de abertura da wallet. */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    createdAt: Date;
  }): WagerTransaction {
    const p: CreateWagerTransactionProps = {
      ...props,
      providerId: "internal",
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `opening:${props.walletId}`,
      roundId: "opening",
      gameId: "internal",
      kind: WagerTransactionKind.Opening,
    };
    WagerTransaction.validate(p);
    return WagerTransaction.fresh(p);
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.resultBalance,
      s.referenceAttempts,
      s.nextReferenceCheckAt,
    );
  }

  private static fresh(p: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      p.id,
      p.providerId,
      p.externalTransactionId,
      p.idempotencyKey,
      p.payloadHash,
      p.walletId,
      p.playerId,
      p.roundId,
      p.gameId,
      p.kind,
      p.money,
      p.referenceExternalTransactionId,
      p.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  private static validate(p: CreateWagerTransactionProps): void {
    if (!p.money.isPositive()) {
      throw new InvalidWagerTransactionError("Amount must be greater than zero");
    }
    const requiresRef =
      p.kind === WagerTransactionKind.Refund || p.kind === WagerTransactionKind.Rollback;
    const hasRef = p.referenceExternalTransactionId !== undefined;
    if (requiresRef && !hasRef) {
      throw new InvalidWagerTransactionError(`${p.kind} requires referenceExternalTransactionId`);
    }
    if (hasRef && (p.kind === WagerTransactionKind.Bet || p.kind === WagerTransactionKind.Opening)) {
      throw new InvalidWagerTransactionError(`${p.kind} cannot reference another transaction`);
    }
    if (hasRef && p.referenceExternalTransactionId === p.externalTransactionId) {
      throw new InvalidWagerTransactionError("A transaction cannot reference itself");
    }
  }

  // ---- getters

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.assertNotTerminal("markProcessed");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = balanceAfter;
    this._nextReferenceCheckAt = undefined;
  }

  /** Registra (mais) uma tentativa sem referência e agenda a próxima com backoff exponencial. */
  markPendingReference(at: Date, observedBalance: Money): void {
    this.assertNotTerminal("markPendingReference");
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    const { baseDelayMs, maxDelayMs } = REFERENCE_RETRY_POLICY;
    const delay = Math.min(baseDelayMs * 2 ** (this._referenceAttempts - 1), maxDelayMs);
    this._nextReferenceCheckAt = new Date(at.getTime() + delay);
    this._resultBalance = observedBalance;
  }

  reject(code: FailureCode, observedBalance: Money | undefined): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = observedBalance;
    this._nextReferenceCheckAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceCheckAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  hasExhaustedReferenceAttempts(): boolean {
    return this._referenceAttempts >= REFERENCE_RETRY_POLICY.maxAttempts;
  }

  /** false para LOSS: registra resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.isReversal();
  }

  isReversal(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Direção do lançamento. ROLLBACK é o inverso da direção da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError("ROLLBACK direction depends on its reference");
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError("LOSS does not move balance");
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot ${transition}: transaction ${this.id} is already ${this._status}`,
      );
    }
  }
}
