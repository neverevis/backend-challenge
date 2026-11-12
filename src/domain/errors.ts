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
