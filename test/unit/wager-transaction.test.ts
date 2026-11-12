import { describe, expect, test } from "bun:test";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "../../src/domain/errors";
import { FailureCode } from "../../src/domain/failure-code";
import {
  REFERENCE_RETRY_POLICY,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../../src/domain/wager-transaction";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";
import { AT, brl, tx } from "./helpers";

describe("WagerTransaction.create", () => {
  test("nasce PENDING", () => {
    expect(tx(K.Bet, "10.00").status).toBe(S.Pending);
  });

  test("OPENING não pode ser submetido externamente", () => {
    expect(() => tx(K.Opening, "10.00")).toThrow(InvalidWagerTransactionError);
  });

  test.each([K.Refund, K.Rollback])("%s exige referência", (kind) => {
    expect(() => tx(kind, "10.00")).toThrow(InvalidWagerTransactionError);
    expect(() => tx(kind, "10.00", { referenceExternalTransactionId: "bet-1" })).not.toThrow();
  });

  test("BET não pode ter referência", () => {
    expect(() => tx(K.Bet, "10.00", { referenceExternalTransactionId: "x" })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test("não pode referenciar a si mesma", () => {
    expect(() =>
      tx(K.Refund, "10.00", { externalTransactionId: "a", referenceExternalTransactionId: "a" }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test("valor zero é inválido", () => {
    expect(() => tx(K.Bet, "0.00")).toThrow(InvalidWagerTransactionError);
  });
});

describe("transições", () => {
  test.each([
    ["markProcessed", (t: WagerTransaction) => t.markProcessed(undefined, AT, brl("1.00"))],
    ["reject", (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, brl("1.00"))],
    ["fail", (t: WagerTransaction) => t.fail(FailureCode.ProcessingFailed)],
    ["markPendingReference", (t: WagerTransaction) => t.markPendingReference(AT, brl("1.00"))],
  ])("estado terminal não aceita %s", (_name, transition) => {
    for (const terminal of [
      (t: WagerTransaction) => t.markProcessed(undefined, AT, brl("1.00")),
      (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, brl("1.00")),
      (t: WagerTransaction) => t.fail(FailureCode.ProcessingFailed),
    ]) {
      const t = tx(K.Bet, "1.00");
      terminal(t);
      expect(t.isTerminal()).toBe(true);
      expect(() => transition(t)).toThrow(InvalidTransactionStateError);
    }
  });

  test("PENDING_REFERENCE aplica backoff exponencial limitado", () => {
    const t = tx(K.Refund, "1.00", { referenceExternalTransactionId: "bet" });
    const delays: number[] = [];
    for (let i = 0; i < REFERENCE_RETRY_POLICY.maxAttempts; i++) {
      t.markPendingReference(AT, brl("0"));
      delays.push(t.nextReferenceCheckAt!.getTime() - AT.getTime());
    }
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(Math.max(...delays)).toBe(REFERENCE_RETRY_POLICY.maxDelayMs);
    expect(t.hasExhaustedReferenceAttempts()).toBe(true);
    expect(t.isTerminal()).toBe(false);
  });
});

describe("consultas", () => {
  test("LOSS não afeta saldo", () => {
    expect(tx(K.Loss, "1.00").affectsBalance()).toBe(false);
    expect(() => tx(K.Loss, "1.00").ledgerDirectionFor()).toThrow();
  });

  test("direções do ledger", () => {
    const bet = tx(K.Bet, "1.00");
    const win = tx(K.Win, "1.00");
    const rb = tx(K.Rollback, "1.00", { referenceExternalTransactionId: "x" });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx(K.Refund, "1.00", { referenceExternalTransactionId: "x" }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(rb.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  test("matchesPayload compara o hash", () => {
    const t = tx(K.Bet, "1.00", { payloadHash: "abc" });
    expect(t.matchesPayload("abc")).toBe(true);
    expect(t.matchesPayload("abd")).toBe(false);
  });
});
