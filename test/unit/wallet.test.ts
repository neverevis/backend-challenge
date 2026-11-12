import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  UnbalancedLedgerEntryError,
} from "../../src/domain/errors";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../src/domain/wallet-ledger-entry";
import { AT, brl, id, PLAYER, wallet } from "./helpers";

const move = (amount: string) => ({ money: brl(amount), transactionId: id(), entryId: id(), at: AT });

describe("Wallet.open", () => {
  test("nasce com version 1 e lançamento de abertura quando saldo > 0", () => {
    const { wallet: w, openingEntry } = Wallet.open({
      id: "w1",
      playerId: PLAYER,
      initialBalance: brl("1000.00"),
      openingTransactionId: "t1",
      openingEntryId: "e1",
      at: AT,
    });
    expect(w.version).toBe(1);
    expect(w.balance.amount).toBe("1000.00");
    expect(w.currency).toBe("BRL");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.amount).toBe("1000.00");
  });

  test("saldo zero não gera lançamento", () => {
    const { openingEntry } = Wallet.open({
      id: "w1",
      playerId: PLAYER,
      initialBalance: brl("0"),
      openingTransactionId: "t1",
      openingEntryId: "e1",
      at: AT,
    });
    expect(openingEntry).toBeUndefined();
  });
});

describe("Wallet.debit / credit", () => {
  test("debita, gera lançamento consistente e incrementa a versão", () => {
    const w = wallet("100.00");
    const entry = w.debit(move("80.00"));
    expect(w.balance.amount).toBe("20.00");
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe("100.00");
    expect(entry.balanceAfter.amount).toBe("20.00");
    expect(entry.isBalanced()).toBe(true);
  });

  test("nunca fica negativo: débito acima do saldo lança e não altera nada", () => {
    const w = wallet("100.00");
    w.debit(move("80.00"));
    expect(() => w.debit(move("80.00"))).toThrow(InsufficientFundsError);
    expect(w.balance.amount).toBe("20.00");
    expect(w.version).toBe(2);
  });

  test("pode debitar exatamente o saldo inteiro", () => {
    const w = wallet("50.00");
    w.debit(move("50.00"));
    expect(w.balance.isZero()).toBe(true);
  });

  test("crédito incrementa saldo e versão", () => {
    const w = wallet("10.00");
    w.credit(move("5.50"));
    expect(w.balance.amount).toBe("15.50");
    expect(w.version).toBe(2);
  });

  test("moeda diferente da wallet lança CurrencyMismatchError", () => {
    const w = wallet("10.00");
    const usd = { ...move("1.00"), money: Money.from({ amount: "1.00", currency: "USD" }) };
    expect(() => w.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => w.debit(usd)).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test("valor zero não move saldo (lançamento exige valor positivo)", () => {
    const w = wallet("10.00");
    expect(() => w.credit(move("0"))).toThrow(UnbalancedLedgerEntryError);
    expect(w.version).toBe(1);
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    id: "e",
    walletId: "w",
    transactionId: "t",
    createdAt: AT,
  };

  test("create rejeita aritmética que não fecha", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl("10.00"),
        balanceBefore: brl("5.00"),
        balanceAfter: brl("14.99"),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test("é estruturalmente imutável", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl("1.00"),
      balanceBefore: brl("5.00"),
      balanceAfter: brl("4.00"),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = "CREDIT";
    }).toThrow();
  });
});
