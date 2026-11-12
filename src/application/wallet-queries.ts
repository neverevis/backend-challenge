import { type MoneyProps } from "../domain/money";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { NotFoundError, ValidationError } from "./errors";
import { type Logger, type Metrics } from "./ports/observability";
import { type UnitOfWork } from "./ports/repositories";

export interface LedgerPageResult {
  items: WalletLedgerEntry[];
  /** Cursor opaco para a próxima página; null quando acabou. */
  nextCursor: string | null;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Cursor opaco: base64url de {"s": seq}. O seq é monotônico por wallet
 * (inserções serializadas pelo lock), então a paginação é estável mesmo com
 * novos lançamentos chegando.
 */
const encodeCursor = (seq: string) => Buffer.from(JSON.stringify({ s: seq })).toString("base64url");
function decodeCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s?: unknown };
    if (typeof parsed.s === "string" && /^\d+$/.test(parsed.s)) return parsed.s;
  } catch {
    /* cai no erro abaixo */
  }
  throw new ValidationError([{ field: "cursor", message: "is invalid" }]);
}

export class WalletQueries {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.read((r) => r.wallets.findById(walletId));
    if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);
    return wallet;
  }

  async getLedger(walletId: string, opts: { cursor?: string; limit?: number }): Promise<LedgerPageResult> {
    const limit = opts.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError([{ field: "limit", message: "must be an integer between 1 and 200" }]);
    }
    const beforeSeq = opts.cursor ? decodeCursor(opts.cursor) : undefined;
    return this.uow.read(async (r) => {
      const wallet = await r.wallets.findById(walletId);
      if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);
      const page = await r.ledger.listByWallet(walletId, { beforeSeq, limit });
      return {
        items: page.entries.map((e) => e.entry),
        nextCursor: page.nextSeq ? encodeCursor(page.nextSeq) : null,
      };
    });
  }

  async getTransaction(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((r) => r.transactions.findById(transactionId));
    if (!tx) throw new NotFoundError(`Transaction ${transactionId} not found`);
    return tx;
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((r) => r.transactions.findByExternalId(providerId, externalTransactionId));
    if (!tx) throw new NotFoundError(`Transaction ${providerId}/${externalTransactionId} not found`);
    return tx;
  }

  /**
   * Recalcula o saldo a partir do ledger (créditos - débitos) e compara com o
   * saldo materializado. Snapshot REPEATABLE READ: as duas leituras enxergam o
   * mesmo instante. Divergência NÃO é corrigida: é logada, contada e sinalizada.
   */
  async reconcile(walletId: string, correlationId: string): Promise<ReconciliationResult> {
    const result = await this.uow.read(async (r) => {
      const wallet = await r.wallets.findById(walletId);
      if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);
      const summary = await r.ledger.summarize(walletId, wallet.currency);
      const calculated = summary.credits.subtract(summary.debits);
      const difference = wallet.balance.subtract(calculated);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: summary.count,
      };
    });

    this.metrics.increment("wallet_reconciliations_total", { consistent: String(result.consistent) });
    if (!result.consistent) {
      this.metrics.increment("wallet_reconciliation_mismatches_total");
      this.logger.error("wallet reconciliation mismatch", {
        correlationId,
        walletId,
        difference: result.difference.amount,
        checkedEntries: result.checkedEntries,
      });
    }
    return result;
  }
}
