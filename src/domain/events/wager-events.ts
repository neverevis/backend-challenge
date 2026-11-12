import { FailureCode } from "../failure-code";
import { type MoneyProps } from "../money";
import { WagerTransaction, WagerTransactionKind } from "../wager-transaction";
import { Wallet } from "../wallet";
import { LedgerDirection, WalletLedgerEntry } from "../wallet-ledger-entry";
import { type EventContext, IntegrationEvent } from "./integration-event";

/*
 * Todos os eventos usam a walletId como aggregateId: é a unidade de
 * concorrência e de ordenação (vira o MessageGroupId na fila FIFO).
 * `data` carrega MoneyProps (string), nunca a instância de Money.
 */

interface TransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionRef(tx: WagerTransaction): TransactionRef {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends TransactionRef {
  referenceTransactionId: string | null;
  balance: MoneyProps | null;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      IntegrationEvent.props(tx.walletId, ctx, {
        ...transactionRef(tx),
        referenceTransactionId: tx.referenceTransactionId ?? null,
        balance: tx.resultBalance?.toJSON() ?? null,
        processedAt: (tx.processedAt ?? ctx.occurredAt).toISOString(),
      }),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionRejectedData extends TransactionRef {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) throw new Error("Rejected transaction without failureCode");
    return new WagerTransactionRejected(
      IntegrationEvent.props(tx.walletId, ctx, {
        ...transactionRef(tx),
        failureCode: tx.failureCode,
      }),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData extends TransactionRef {
  referenceExternalTransactionId: string;
  attempts: number;
  nextCheckAt: string | null;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      IntegrationEvent.props(tx.walletId, ctx, {
        ...transactionRef(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? "",
        attempts: tx.referenceAttempts,
        nextCheckAt: tx.nextReferenceCheckAt?.toISOString() ?? null,
      }),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Publicado somente quando o saldo muda (ou seja, quando há lançamento). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.props(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}
