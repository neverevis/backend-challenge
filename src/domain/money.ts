import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidCurrencyError, InvalidMoneyError } from "./errors";

/** Formato de dinheiro nos contratos (HTTP, SQS, eventos). */
export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

/** Escala fixa: 2 casas decimais. */
const SCALE = 2;

/**
 * Formato aceito na entrada:
 *  - só dígitos, opcionalmente "." + 1 ou 2 dígitos;
 *  - sem sinal, sem espaços, sem notação científica, sem zeros à esquerda ("007");
 *  - até 18 dígitos inteiros (cabe em NUMERIC(20,2) no Postgres).
 * Mais de 2 casas é rejeitado em vez de arredondado: arredondar dinheiro
 * silenciosamente esconde erro de quem enviou.
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Value object imutável de dinheiro. Nunca usa `number`:
 * internamente é um Decimal de precisão arbitrária.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Cria a partir do contrato. Rejeita valores negativos e formatos inválidos. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== "object") {
      throw new InvalidMoneyError("Money must be an object { amount, currency }");
    }
    const { amount, currency } = props;
    Money.assertValidCurrency(currency);
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid amount: expected a non-negative decimal string with up to ${SCALE} decimal places`,
      );
    }
    return new Money(new Decimal(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  /** Sempre 2 casas: "25.00", "-3.50". */
  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertValidCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidCurrencyError("Currency must be an ISO-4217 code (3 uppercase letters)");
    }
  }
}
