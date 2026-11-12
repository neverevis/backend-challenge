import { EntityManager } from "@mikro-orm/postgresql";
import {
  type LedgerPage,
  type LedgerRepository,
  type LedgerSummary,
  type OutboxRepository,
  type Repositories,
  type WagerTransactionRepository,
  type WalletRepository,
} from "../../application/ports/repositories";
import { FailureCode } from "../../domain/failure-code";
import { Money } from "../../domain/money";
import { OutboxMessage } from "../../domain/outbox-message";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import { toDate, toOptionalDate } from "./pg-errors";

type Row = Record<string, unknown>;

/*
 * Repositórios sobre o EntityManager do MikroORM, com SQL explícito.
 * `em.execute` roda dentro da transação aberta por `em.transactional()`.
 * Toda conversão banco ↔ domínio passa pelos `rehydrate`.
 */

const money = (amount: unknown, currency: unknown) =>
  Money.from({ amount: String(amount), currency: String(currency).trim() });

// ---------------------------------------------------------------- wallets

const WALLET_COLUMNS = "id, player_id, currency, balance_amount, version, created_at, updated_at";

function toWallet(r: Row): Wallet {
  return Wallet.rehydrate({
    id: String(r.id),
    playerId: String(r.player_id),
    currency: String(r.currency).trim(),
    balance: money(r.balance_amount, r.currency),
    version: Number(r.version),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  });
}

class PgWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string) {
    const rows = await this.em.execute<Row[]>(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ?`, [id]);
    return rows[0] ? toWallet(rows[0]) : undefined;
  }

  async findByIdForUpdate(id: string) {
    // Lock pessimista na linha: outras transações que tocam a MESMA wallet
    // esperam aqui; wallets diferentes seguem em paralelo.
    const rows = await this.em.execute<Row[]>(
      `SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ? FOR UPDATE`,
      [id],
    );
    return rows[0] ? toWallet(rows[0]) : undefined;
  }

  async insert(w: Wallet) {
    await this.em.execute(
      `INSERT INTO wallets (${WALLET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [w.id, w.playerId, w.currency, w.balance.amount, w.version, w.createdAt, w.updatedAt],
    );
  }

  async update(w: Wallet, expectedVersion: number) {
    const rows = await this.em.execute<Row[]>(
      `UPDATE wallets SET balance_amount = ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ? RETURNING id`,
      [w.balance.amount, w.version, w.updatedAt, w.id, expectedVersion],
    );
    if (rows.length !== 1) {
      // Com o FOR UPDATE isso não acontece; se acontecer, aborta a transação.
      throw new Error(`Lost update prevented on wallet ${w.id} (expected version ${expectedVersion})`);
    }
  }
}

// ------------------------------------------------------ wager_transactions

const TX_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash,
  wallet_id, player_id, round_id, game_id, kind, amount, currency,
  reference_external_transaction_id, reference_transaction_id, status, failure_code,
  result_balance_amount, reference_attempts, next_reference_check_at,
  created_at, processed_at, updated_at`;

function toTransaction(r: Row): WagerTransaction {
  const currency = String(r.currency).trim();
  return WagerTransaction.rehydrate({
    id: String(r.id),
    providerId: String(r.provider_id),
    externalTransactionId: String(r.external_transaction_id),
    idempotencyKey: String(r.idempotency_key),
    payloadHash: String(r.payload_hash),
    walletId: String(r.wallet_id),
    playerId: String(r.player_id),
    roundId: String(r.round_id),
    gameId: String(r.game_id),
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount, currency),
    referenceExternalTransactionId: (r.reference_external_transaction_id as string | null) ?? undefined,
    referenceTransactionId: (r.reference_transaction_id as string | null) ?? undefined,
    status: r.status as WagerTransactionStatus,
    failureCode: (r.failure_code as FailureCode | null) ?? undefined,
    resultBalance: r.result_balance_amount === null ? undefined : money(r.result_balance_amount, currency),
    referenceAttempts: Number(r.reference_attempts),
    nextReferenceCheckAt: toOptionalDate(r.next_reference_check_at),
    createdAt: toDate(r.created_at),
    processedAt: toOptionalDate(r.processed_at),
  });
}

class PgWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  private async one(where: string, params: unknown[]) {
    const rows = await this.em.execute<Row[]>(`SELECT ${TX_COLUMNS} FROM wager_transactions WHERE ${where}`, params);
    return rows[0] ? toTransaction(rows[0]) : undefined;
  }

  findById(id: string) {
    return this.one("id = ?", [id]);
  }

  findByIdempotencyKey(providerId: string, idempotencyKey: string) {
    return this.one("provider_id = ? AND idempotency_key = ?", [providerId, idempotencyKey]);
  }

  findByExternalId(providerId: string, externalTransactionId: string) {
    return this.one("provider_id = ? AND external_transaction_id = ?", [providerId, externalTransactionId]);
  }

  async hasProcessedReversal(referenceTransactionId: string) {
    const rows = await this.em.execute<Row[]>(
      `SELECT 1 FROM wager_transactions
        WHERE reference_transaction_id = ? AND kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
        LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async insert(t: WagerTransaction) {
    await this.em.execute(
      `INSERT INTO wager_transactions (${TX_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id,
        t.providerId,
        t.externalTransactionId,
        t.idempotencyKey,
        t.payloadHash,
        t.walletId,
        t.playerId,
        t.roundId,
        t.gameId,
        t.kind,
        t.money.amount,
        t.money.currency,
        t.referenceExternalTransactionId ?? null,
        t.referenceTransactionId ?? null,
        t.status,
        t.failureCode ?? null,
        t.resultBalance?.amount ?? null,
        t.referenceAttempts,
        t.nextReferenceCheckAt ?? null,
        t.createdAt,
        t.processedAt ?? null,
        new Date(),
      ],
    );
  }

  /** Só os campos mutáveis. O trigger do banco barra o resto. */
  async update(t: WagerTransaction) {
    await this.em.execute(
      `UPDATE wager_transactions
          SET status = ?, reference_transaction_id = ?, failure_code = ?, result_balance_amount = ?,
              reference_attempts = ?, next_reference_check_at = ?, processed_at = ?, updated_at = ?
        WHERE id = ?`,
      [
        t.status,
        t.referenceTransactionId ?? null,
        t.failureCode ?? null,
        t.resultBalance?.amount ?? null,
        t.referenceAttempts,
        t.nextReferenceCheckAt ?? null,
        t.processedAt ?? null,
        new Date(),
        t.id,
      ],
    );
  }

  async expediteWaitingFor(providerId: string, externalTransactionId: string, at: Date) {
    await this.em.execute(
      `UPDATE wager_transactions SET next_reference_check_at = ?, updated_at = ?
        WHERE provider_id = ? AND reference_external_transaction_id = ? AND status = 'PENDING_REFERENCE'`,
      [at, at, providerId, externalTransactionId],
    );
  }
}

// ------------------------------------------------------------------ ledger

function toLedgerEntry(r: Row): WalletLedgerEntry {
  const currency = String(r.currency).trim();
  return WalletLedgerEntry.rehydrate({
    id: String(r.id),
    walletId: String(r.wallet_id),
    transactionId: String(r.transaction_id),
    direction: r.direction as LedgerDirection,
    money: money(r.amount, currency),
    balanceBefore: money(r.balance_before_amount, currency),
    balanceAfter: money(r.balance_after_amount, currency),
    createdAt: toDate(r.created_at),
  });
}

class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(e: WalletLedgerEntry) {
    await this.em.execute(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency,
          balance_before_amount, balance_after_amount, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.id,
        e.walletId,
        e.transactionId,
        e.direction,
        e.money.amount,
        e.money.currency,
        e.balanceBefore.amount,
        e.balanceAfter.amount,
        e.createdAt,
      ],
    );
  }

  async listByWallet(walletId: string, opts: { beforeSeq?: string; limit: number }): Promise<LedgerPage> {
    const rows = await this.em.execute<Row[]>(
      `SELECT seq::text AS seq, id, wallet_id, transaction_id, direction, amount, currency,
              balance_before_amount, balance_after_amount, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? ${opts.beforeSeq ? "AND seq < ?" : ""}
        ORDER BY seq DESC
        LIMIT ?`,
      opts.beforeSeq ? [walletId, opts.beforeSeq, opts.limit + 1] : [walletId, opts.limit + 1],
    );
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit);
    return {
      entries: page.map((r) => ({ seq: String(r.seq), entry: toLedgerEntry(r) })),
      nextSeq: hasMore ? String(page[page.length - 1]?.seq) : undefined,
    };
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const rows = await this.em.execute<Row[]>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::numeric(20,2) AS credits,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::numeric(20,2)  AS debits,
              COUNT(*)::int AS count
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    const r = rows[0] ?? { credits: "0", debits: "0", count: 0 };
    return { credits: money(r.credits, currency), debits: money(r.debits, currency), count: Number(r.count) };
  }
}

// ------------------------------------------------------------------ outbox

class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: OutboxMessage[]) {
    for (const m of messages) {
      await this.em.execute(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?::jsonb, ?, ?, ?)`,
        [m.id, m.aggregateId, m.eventType, JSON.stringify(m.payload), m.occurredAt, m.attempts, m.nextAttemptAt ?? null],
      );
    }
  }
}

export function pgRepositories(em: EntityManager): Repositories {
  return {
    wallets: new PgWalletRepository(em),
    transactions: new PgWagerTransactionRepository(em),
    ledger: new PgLedgerRepository(em),
    outbox: new PgOutboxRepository(em),
  };
}
