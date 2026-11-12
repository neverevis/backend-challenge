import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../src/domain/failure-code";
import { Money } from "../../src/domain/money";
import { type ReferenceResolution, settleWagerTransaction } from "../../src/domain/wager-settlement";
import {
  REFERENCE_RETRY_POLICY,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../../src/domain/wager-transaction";
import { Wallet } from "../../src/domain/wallet";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";
import { AT, brl, id, tx, wallet } from "./helpers";

function settle(w: Wallet, t: WagerTransaction, reference?: ReferenceResolution) {
  return settleWagerTransaction({ wallet: w, transaction: t, reference, ledgerEntryId: id(), at: AT });
}

/** Cria e aplica uma transação, para servir de referência. */
function processed(w: Wallet, kind: K, amount: string, ref?: WagerTransaction) {
  const t = tx(kind, amount, ref ? { referenceExternalTransactionId: ref.externalTransactionId } : {});
  settle(w, t, ref ? { found: true, transaction: ref, alreadyReversed: false } : undefined);
  expect(t.status).toBe(S.Processed);
  return t;
}

const found = (transaction: WagerTransaction, alreadyReversed = false): ReferenceResolution => ({
  found: true,
  transaction,
  alreadyReversed,
});

describe("BET", () => {
  test("debita e gera 1 lançamento DEBIT", () => {
    const w = wallet("100.00");
    const t = tx(K.Bet, "25.00");
    const out = settle(w, t);
    expect(out.status).toBe(S.Processed);
    expect(out.status === S.Processed && out.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe("75.00");
    expect(t.resultBalance?.amount).toBe("75.00");
  });

  test("cenário da seção 8: 100 de saldo, duas apostas de 80", () => {
    const w = wallet("100.00");
    const a = tx(K.Bet, "80.00");
    const b = tx(K.Bet, "80.00");
    expect(settle(w, a).status).toBe(S.Processed);
    const out = settle(w, b);
    expect(out).toEqual({ status: S.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(w.balance.amount).toBe("20.00");
    expect(b.resultBalance?.amount).toBe("20.00");
  });
});

describe("WIN / LOSS", () => {
  test("WIN credita", () => {
    const w = wallet("0");
    expect(settle(w, tx(K.Win, "50.00")).status).toBe(S.Processed);
    expect(w.balance.amount).toBe("50.00");
  });

  test("LOSS é processada sem mover saldo nem gerar lançamento", () => {
    const w = wallet("10.00");
    const out = settle(w, tx(K.Loss, "10.00"));
    expect(out).toEqual({ status: S.Processed });
    expect(w.balance.amount).toBe("10.00");
    expect(w.version).toBe(1);
  });

  test("WIN com referência a uma BET processada guarda o id interno da referência", () => {
    const w = wallet("100.00");
    const bet = processed(w, K.Bet, "10.00");
    const win = tx(K.Win, "30.00", { referenceExternalTransactionId: bet.externalTransactionId });
    settle(w, win, found(bet));
    expect(win.referenceTransactionId).toBe(bet.id);
  });
});

describe("REFUND", () => {
  test("credita o valor da BET", () => {
    const w = wallet("100.00");
    const bet = processed(w, K.Bet, "40.00");
    const refund = tx(K.Refund, "40.00", { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(w, refund, found(bet)).status).toBe(S.Processed);
    expect(w.balance.amount).toBe("100.00");
  });

  test.each([
    ["só referencia BET", K.Win, "40.00", false, FailureCode.ReferenceKindNotAllowed],
    ["valor diferente (sem reversão parcial)", K.Bet, "39.99", false, FailureCode.ReferenceAmountMismatch],
    ["uma única vez", K.Bet, "40.00", true, FailureCode.ReferenceAlreadyReversed],
  ])("%s", (_name, refKind, refundAmount, alreadyReversed, code) => {
    const w = wallet("100.00");
    const ref = processed(w, refKind, "40.00");
    const refund = tx(K.Refund, refundAmount, { referenceExternalTransactionId: ref.externalTransactionId });
    expect(settle(w, refund, found(ref, alreadyReversed))).toEqual({
      status: S.Rejected,
      failureCode: code,
    });
  });

  test("referência de outra rodada é rejeitada", () => {
    const w = wallet("100.00");
    const bet = processed(w, K.Bet, "40.00");
    const refund = tx(K.Refund, "40.00", {
      referenceExternalTransactionId: bet.externalTransactionId,
      roundId: "outra-rodada",
    });
    expect(settle(w, refund, found(bet))).toEqual({
      status: S.Rejected,
      failureCode: FailureCode.ReferenceMismatch,
    });
  });

  test("referência REJECTED não pode ser revertida", () => {
    const w = wallet("10.00");
    const bet = tx(K.Bet, "40.00");
    settle(w, bet); // rejeitada por saldo
    const refund = tx(K.Refund, "40.00", { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(w, refund, found(bet))).toEqual({
      status: S.Rejected,
      failureCode: FailureCode.ReferenceNotProcessed,
    });
    expect(w.balance.amount).toBe("10.00");
  });
});

describe("ROLLBACK", () => {
  test("de BET credita", () => {
    const w = wallet("100.00");
    const bet = processed(w, K.Bet, "30.00");
    const rb = tx(K.Rollback, "30.00", { referenceExternalTransactionId: bet.externalTransactionId });
    settle(w, rb, found(bet));
    expect(w.balance.amount).toBe("100.00");
  });

  test("de WIN debita", () => {
    const w = wallet("0");
    const win = processed(w, K.Win, "30.00");
    const rb = tx(K.Rollback, "30.00", { referenceExternalTransactionId: win.externalTransactionId });
    settle(w, rb, found(win));
    expect(w.balance.amount).toBe("0.00");
  });

  test("de REFUND debita", () => {
    const w = wallet("100.00");
    const bet = processed(w, K.Bet, "30.00");
    const refund = processed(w, K.Refund, "30.00", bet);
    const rb = tx(K.Rollback, "30.00", { referenceExternalTransactionId: refund.externalTransactionId });
    settle(w, rb, found(refund));
    expect(w.balance.amount).toBe("70.00");
  });

  test("que deixaria saldo negativo é rejeitado com código distinto de aposta sem saldo", () => {
    const w = wallet("0");
    const win = processed(w, K.Win, "30.00");
    processed(w, K.Bet, "25.00"); // jogador gastou o prêmio: saldo 5
    const rb = tx(K.Rollback, "30.00", { referenceExternalTransactionId: win.externalTransactionId });
    expect(settle(w, rb, found(win))).toEqual({
      status: S.Rejected,
      failureCode: FailureCode.ReversalInsufficientFunds,
    });
    expect(w.balance.amount).toBe("5.00");
  });

  test("não pode referenciar LOSS", () => {
    const w = wallet("10.00");
    const loss = processed(w, K.Loss, "10.00");
    const rb = tx(K.Rollback, "10.00", { referenceExternalTransactionId: loss.externalTransactionId });
    expect(settle(w, rb, found(loss))).toEqual({
      status: S.Rejected,
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });
});

describe("referência fora de ordem", () => {
  test("referência ausente vira PENDING_REFERENCE sem mexer no saldo", () => {
    const w = wallet("10.00");
    const refund = tx(K.Refund, "5.00", { referenceExternalTransactionId: "ainda-nao-chegou" });
    expect(settle(w, refund, { found: false })).toEqual({ status: S.PendingReference });
    expect(refund.status).toBe(S.PendingReference);
    expect(w.version).toBe(1);
  });

  test("ao esgotar as tentativas, é REJECTED com REFERENCE_NOT_FOUND", () => {
    const w = wallet("10.00");
    const refund = tx(K.Refund, "5.00", { referenceExternalTransactionId: "nunca-chega" });
    for (let i = 0; i < REFERENCE_RETRY_POLICY.maxAttempts; i++) settle(w, refund, { found: false });
    expect(refund.status).toBe(S.PendingReference);
    expect(settle(w, refund, { found: false })).toEqual({
      status: S.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
    });
  });

  test("referência chega depois: o retry processa normalmente", () => {
    const w = wallet("100.00");
    const refund = tx(K.Refund, "20.00", { referenceExternalTransactionId: "bet-x" });
    settle(w, refund, { found: false });
    const bet = tx(K.Bet, "20.00", { externalTransactionId: "bet-x" });
    settle(w, bet);
    expect(settle(w, refund, found(bet)).status).toBe(S.Processed);
    expect(w.balance.amount).toBe("100.00");
  });
});

describe("consistência com a wallet", () => {
  test("player diferente do dono da wallet é rejeitado", () => {
    const w = wallet("10.00");
    const t = tx(K.Bet, "1.00", { playerId: "outro" });
    expect(settle(w, t)).toEqual({ status: S.Rejected, failureCode: FailureCode.WalletPlayerMismatch });
  });

  test("moeda diferente da wallet é rejeitada sem mover saldo", () => {
    const w = wallet("10.00");
    const t = tx(K.Bet, "1.00", { money: Money.from({ amount: "1.00", currency: "USD" }) });
    expect(settle(w, t)).toEqual({ status: S.Rejected, failureCode: FailureCode.CurrencyMismatch });
    expect(w.balance.equals(brl("10.00"))).toBe(true);
  });
});
