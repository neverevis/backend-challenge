import { Money } from "../../domain/money";
import { OutboxMessage } from "../../domain/outbox-message";
import { WagerTransaction } from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";

/*
 * Portas de persistência. A camada de aplicação só conhece estas interfaces;
 * a implementação com PostgreSQL fica em infrastructure/database.
 */

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE: trava a linha da wallet até o fim da transação. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /**
   * UPDATE condicionado à versão lida (defesa em profundidade: com o lock
   * pessimista isso nunca falha; se falhar, é bug e a transação aborta).
   */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Já existe REFUND/ROLLBACK PROCESSED apontando para esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(tx: WagerTransaction): Promise<void>;
  update(tx: WagerTransaction): Promise<void>;
  /**
   * Antecipa para `at` a próxima checagem das PENDING_REFERENCE que esperam
   * por (providerId, externalTransactionId) — a referência acabou de chegar.
   */
  expediteWaitingFor(providerId: string, externalTransactionId: string, at: Date): Promise<void>;
}

export interface LedgerPage {
  entries: Array<{ seq: string; entry: WalletLedgerEntry }>;
  /** seq do último item, se houver mais páginas */
  nextSeq?: string;
}

export interface LedgerSummary {
  credits: Money;
  debits: Money;
  count: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Mais recentes primeiro. `beforeSeq` é exclusivo. */
  listByWallet(walletId: string, opts: { beforeSeq?: string; limit: number }): Promise<LedgerPage>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export interface OutboxRepository {
  add(messages: OutboxMessage[]): Promise<void>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
}

/**
 * Unidade de trabalho = uma transação SQL. Tudo que for feito com os
 * repositórios recebidos em `fn` é confirmado junto, ou desfeito junto.
 */
export interface UnitOfWork {
  transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
  /** Leitura consistente (snapshot REPEATABLE READ, somente leitura). */
  read<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol("UnitOfWork");
