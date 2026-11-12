/**
 * Erros de domínio: violações de regra de negócio ou de validação.
 * Não dependem de HTTP — quem traduz para status code é a camada de interface.
 */
export abstract class DomainError extends Error {
  /** Código estável, legível por máquina. */
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class InvalidCurrencyError extends DomainError {
  readonly code = "INVALID_CURRENCY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

/** Dados de uma transação violam a forma exigida (ex.: REFUND sem referência). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";
}

/** Débito que deixaria o saldo negativo. */
export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
}

/** Lançamento cuja aritmética não fecha: balanceBefore ± money !== balanceAfter. */
export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = "UNBALANCED_LEDGER_ENTRY";
}

export class InvalidWalletError extends DomainError {
  readonly code = "INVALID_WALLET";
}

/**
 * Tentativa de transição a partir de um estado terminal.
 * É erro de programação, não caminho de negócio (README 6.3).
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
}
