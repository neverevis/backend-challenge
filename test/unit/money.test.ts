import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyError,
} from "../../src/domain/errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from", () => {
  test.each([
    ["25.00", "25.00"],
    ["25", "25.00"],
    ["25.5", "25.50"],
    ["0", "0.00"],
    ["0.01", "0.01"],
    ["999999999999999999.99", "999999999999999999.99"],
  ])("aceita %p e serializa com 2 casas (%p)", (input, expected) => {
    expect(brl(input).amount).toBe(expected);
  });

  test.each([
    ["", "string vazia"],
    ["-1.00", "negativo"],
    ["+1.00", "com sinal"],
    ["1.001", "mais de 2 casas (não arredonda)"],
    ["1e3", "notação científica"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    [" 1.00", "espaço"],
    ["1,00", "vírgula"],
    ["007", "zeros à esquerda"],
    [".50", "sem parte inteira"],
    ["1.", "ponto sem decimais"],
    ["1000000000000000000", "mais de 18 dígitos inteiros"],
  ])("rejeita %p (%s)", (input) => {
    expect(() => brl(input)).toThrow(InvalidMoneyError);
  });

  test("rejeita amount que não é string (number é proibido)", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each(["brl", "BR", "BRLL", "", "R$"])("rejeita moeda inválida %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidCurrencyError);
  });
});

describe("aritmética", () => {
  test("é exata (sem erro de ponto flutuante)", () => {
    expect(brl("0.10").add(brl("0.20")).amount).toBe("0.30");
  });

  test("é imutável: operações retornam nova instância", () => {
    const a = brl("10.00");
    const b = a.add(brl("5.00"));
    expect(a.amount).toBe("10.00");
    expect(b.amount).toBe("15.00");
    expect(b).not.toBe(a);
  });

  test("subtract pode produzir negativo internamente; negate inverte", () => {
    const r = brl("10.00").subtract(brl("25.50"));
    expect(r.amount).toBe("-15.50");
    expect(r.isNegative()).toBe(true);
    expect(r.negate().amount).toBe("15.50");
  });

  test("predicados", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.0").equals(brl("1.00"))).toBe(true);
  });
});

describe("conflito de moeda", () => {
  const usd = Money.from({ amount: "1.00", currency: "USD" });

  test.each([
    ["add", () => brl("1.00").add(usd)],
    ["subtract", () => brl("1.00").subtract(usd)],
    ["isLessThan", () => brl("1.00").isLessThan(usd)],
  ])("%s entre moedas diferentes lança erro de domínio", (_name, op) => {
    expect(op).toThrow(CurrencyMismatchError);
  });

  test("equals entre moedas diferentes é false (não lança)", () => {
    expect(brl("1.00").equals(usd)).toBe(false);
  });
});

describe("serialização", () => {
  test("toJSON usa o formato do contrato", () => {
    expect(JSON.stringify({ money: brl("25") })).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"}}',
    );
  });
});
