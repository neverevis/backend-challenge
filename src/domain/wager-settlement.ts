import { FailureCode } from "./failure-code";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";
import { Wallet } from "./wallet";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

/**
 * Resultado da busca da transação referenciada, feita pela camada de aplicação
 * (dentro da transação SQL, com a wallet travada).
 */
export type ReferenceResolution =
  | { found: false }
  | { found: true; transaction: WagerTransaction; alreadyReversed: boolean };

export type SettlementOutcome =
  | { status: WagerTransactionStatus.Processed; ledgerEntry?: WalletLedgerEntry }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

/** Quais tipos cada operação pode referenciar (README 7, regra 3). */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * Serviço de domínio: aplica uma transação PENDING/PENDING_REFERENCE à wallet.
 *
 * Função pura sobre objetos em memória — não sabe de banco nem de lock.
 * Quem chama garante que a wallet está travada e persiste o resultado.
 * Muta `wallet` e `transaction` e devolve o lançamento, se houver.
 */
export function settleWagerTransaction(params: {
  wallet: Wallet;
  transaction: WagerTransaction;
  reference?: ReferenceResolution;
  ledgerEntryId: string;
  at: Date;
}): SettlementOutcome {
  const { wallet, transaction: tx, at } = params;

  const reject = (failureCode: FailureCode): SettlementOutcome => {
    tx.reject(failureCode, wallet.balance);
    return { status: WagerTransactionStatus.Rejected, failureCode };
  };

  if (tx.walletId !== wallet.id) {
    throw new Error(`Programming error: transaction ${tx.id} does not belong to wallet ${wallet.id}`);
  }
  if (tx.playerId !== wallet.playerId) return reject(FailureCode.WalletPlayerMismatch);
  if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

  // ---- referência
  let reference: WagerTransaction | undefined;
  if (tx.referenceExternalTransactionId !== undefined) {
    const resolution = params.reference;
    if (!resolution) {
      throw new Error("Programming error: reference resolution is required");
    }
    if (!resolution.found) {
      if (tx.hasExhaustedReferenceAttempts()) return reject(FailureCode.ReferenceNotFound);
      tx.markPendingReference(at, wallet.balance);
      return { status: WagerTransactionStatus.PendingReference };
    }
    reference = resolution.transaction;

    const problem = checkReference(tx, reference, resolution.alreadyReversed);
    if (problem === "WAIT") {
      // A referência existe mas ainda não foi aplicada: espera como se não existisse.
      if (tx.hasExhaustedReferenceAttempts()) return reject(FailureCode.ReferenceNotProcessed);
      tx.markPendingReference(at, wallet.balance);
      return { status: WagerTransactionStatus.PendingReference };
    }
    if (problem) return reject(problem);
  }

  // ---- efeito no saldo
  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, at, wallet.balance);
    return { status: WagerTransactionStatus.Processed };
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    // Reversão sem saldo é operacionalmente diferente de aposta sem saldo (README 7, regra 9).
    return reject(
      tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds,
    );
  }

  const movement = {
    money: tx.money,
    transactionId: tx.id,
    entryId: params.ledgerEntryId,
    at,
  };
  const ledgerEntry =
    direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);

  tx.markProcessed(reference?.id, at, wallet.balance);
  return { status: WagerTransactionStatus.Processed, ledgerEntry };
}

function checkReference(
  tx: WagerTransaction,
  ref: WagerTransaction,
  alreadyReversed: boolean,
): FailureCode | "WAIT" | undefined {
  const allowed = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
  if (!allowed.includes(ref.kind)) return FailureCode.ReferenceKindNotAllowed;

  const sameContext =
    ref.providerId === tx.providerId &&
    ref.playerId === tx.playerId &&
    ref.walletId === tx.walletId &&
    ref.money.currency === tx.money.currency &&
    ref.roundId === tx.roundId;
  if (!sameContext) return FailureCode.ReferenceMismatch;

  if (
    ref.status === WagerTransactionStatus.Pending ||
    ref.status === WagerTransactionStatus.PendingReference
  ) {
    return "WAIT";
  }
  if (ref.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;

  if (tx.isReversal()) {
    if (!ref.money.equals(tx.money)) return FailureCode.ReferenceAmountMismatch;
    if (alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
  }
  return undefined;
}
