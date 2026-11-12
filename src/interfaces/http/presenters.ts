import { type WagerResult } from "../../application/process-wager-transaction";
import { WagerTransaction, WagerTransactionStatus } from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";

/**
 * Status HTTP por resultado da transação. Replay devolve o MESMO status
 * da resposta original (só muda `idempotentReplay`).
 *
 *   PROCESSED          200  aplicada
 *   PENDING_REFERENCE  202  aceita, aguardando a referência
 *   REJECTED           422  regra de negócio — não adianta reenviar igual
 *   FAILED             422  falha permanente registrada — não adianta reenviar igual
 */
export function httpStatusFor(result: WagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
  }
}

export const presentWallet = (w: Wallet) => ({
  id: w.id,
  playerId: w.playerId,
  balance: w.balance.toJSON(),
  version: w.version,
  createdAt: w.createdAt.toISOString(),
  updatedAt: w.updatedAt.toISOString(),
});

export const presentLedgerEntry = (e: WalletLedgerEntry) => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  createdAt: e.createdAt.toISOString(),
});

export const presentTransaction = (t: WagerTransaction) => ({
  id: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  money: t.money.toJSON(),
  referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
  referenceTransactionId: t.referenceTransactionId ?? null,
  status: t.status,
  failureCode: t.failureCode ?? null,
  balance: t.resultBalance?.toJSON() ?? null,
  referenceAttempts: t.referenceAttempts,
  createdAt: t.createdAt.toISOString(),
  processedAt: t.processedAt?.toISOString() ?? null,
});
