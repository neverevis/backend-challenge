import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events/wager-events";
import { type EventContext, IntegrationEvent } from "../domain/events/integration-event";
import { FailureCode } from "../domain/failure-code";
import { type MoneyProps } from "../domain/money";
import { OutboxMessage } from "../domain/outbox-message";
import { type ReferenceResolution, settleWagerTransaction } from "../domain/wager-settlement";
import { WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { newId } from "../shared/id";
import { IdempotencyConflictError, RetryableConflictError, UniqueViolationError } from "./errors";
import { type Logger, type Metrics } from "./ports/observability";
import { type Repositories, type UnitOfWork } from "./ports/repositories";
import { type SubmitWagerCommand } from "./submit-wager-command";

export interface WagerResult {
  /** null apenas quando a wallet não existe (nada pôde ser persistido). */
  transactionId: string | null;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance: MoneyProps | null;
  idempotentReplay: boolean;
}

/** Quantas vezes repetir a transação inteira em deadlock/serialização. */
const MAX_CONFLICT_RETRIES = 3;

/**
 * Use case central: aplica uma transação de aposta. Usado pela API HTTP,
 * pelo consumidor SQS e pelo worker de referências pendentes.
 *
 * Estratégia de concorrência (ver ARCHITECTURE.md):
 *  1. caminho rápido sem lock: se a idempotency key já existe, é replay;
 *  2. senão, abre transação e trava a wallet com SELECT ... FOR UPDATE;
 *  3. com o lock, verifica a idempotência de novo (outra instância pode ter
 *     acabado de gravar a mesma operação) e só então aplica;
 *  4. transação, saldo, ledger e eventos da outbox são gravados no mesmo COMMIT.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(cmd: SubmitWagerCommand): Promise<WagerResult> {
    const started = performance.now();
    const log = {
      correlationId: cmd.correlationId,
      messageId: cmd.causationId,
      providerId: cmd.providerId,
      walletId: cmd.walletId,
    };

    try {
      const existing = await this.uow.read((r) =>
        r.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey),
      );
      if (existing) return this.replay(existing, cmd);

      for (let attempt = 1; ; attempt++) {
        try {
          const result = await this.uow.transaction((r) => this.applyNew(r, cmd));
          this.metrics.increment("wager_transactions_total", { status: result.status, kind: cmd.kind });
          this.logger.info("wager transaction settled", {
            ...log,
            transactionId: result.transactionId ?? undefined,
            status: result.status,
            failureCode: result.failureCode,
            kind: cmd.kind,
          });
          return result;
        } catch (e) {
          if (e instanceof UniqueViolationError) {
            // Corrida entre duas entregas da mesma operação para wallets
            // diferentes (payload adulterado) ou entre chaves distintas para o
            // mesmo externalId. O banco decidiu; relemos o que venceu.
            const winner = await this.uow.read((r) =>
              r.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey),
            );
            if (winner) return this.replay(winner, cmd);
            throw new IdempotencyConflictError(
              "EXTERNAL_TRANSACTION_ID_CONFLICT",
              "externalTransactionId already used with a different Idempotency-Key",
            );
          }
          if (e instanceof RetryableConflictError && attempt < MAX_CONFLICT_RETRIES) {
            this.metrics.increment("wager_retries_total", { reason: "db_conflict" });
            continue;
          }
          throw e;
        }
      }
    } finally {
      this.metrics.observe("wager_processing_seconds", (performance.now() - started) / 1000, {
        kind: cmd.kind,
      });
    }
  }

  /**
   * Reprocessa uma transação PENDING_REFERENCE (chamado pelo worker agendado).
   * Devolve o novo status, ou undefined se ela já não estava pendente.
   */
  async retryPendingReference(transactionId: string, ctx: { correlationId: string }) {
    return this.uow.transaction(async (r) => {
      const peek = await r.transactions.findById(transactionId);
      if (!peek || peek.status !== WagerTransactionStatus.PendingReference) return undefined;

      // Ordem de lock sempre wallet → transação, igual ao caminho principal.
      const wallet = await r.wallets.findByIdForUpdate(peek.walletId);
      const tx = await r.transactions.findById(transactionId);
      if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return undefined;

      await this.settleAndPersist(r, wallet, tx, { isNew: false, ctx: this.ctx(ctx.correlationId) });
      this.metrics.increment("wager_reference_retries_total", { status: tx.status });
      if (tx.status !== WagerTransactionStatus.PendingReference) {
        this.metrics.increment("wager_transactions_total", { status: tx.status, kind: tx.kind });
      }
      return tx.status;
    });
  }

  // ------------------------------------------------------------------------

  private async applyNew(r: Repositories, cmd: SubmitWagerCommand): Promise<WagerResult> {
    const wallet = await r.wallets.findByIdForUpdate(cmd.walletId);
    if (!wallet) {
      // Sem wallet não há onde ancorar a transação (FK); a resposta é
      // determinística, então reenviar dá o mesmo resultado.
      return {
        transactionId: null,
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.WalletNotFound,
        balance: null,
        idempotentReplay: false,
      };
    }

    // Segunda checagem, agora serializada pelo lock da wallet.
    const existing = await r.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey);
    if (existing) return this.replay(existing, cmd);

    const sameExternalId = await r.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId);
    if (sameExternalId) {
      this.metrics.increment("wager_idempotency_conflicts_total", { reason: "external_id" });
      throw new IdempotencyConflictError(
        "EXTERNAL_TRANSACTION_ID_CONFLICT",
        "externalTransactionId already used with a different Idempotency-Key",
      );
    }

    const tx = WagerTransaction.create({
      id: newId(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: cmd.payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: cmd.money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: this.clock(),
    });

    await this.settleAndPersist(r, wallet, tx, {
      isNew: true,
      ctx: this.ctx(cmd.correlationId, cmd.causationId),
    });
    return toResult(tx, false);
  }

  /** Resolve a referência, aplica as regras e grava tudo. Wallet já travada. */
  private async settleAndPersist(
    r: Repositories,
    wallet: Wallet,
    tx: WagerTransaction,
    opts: { isNew: boolean; ctx: EventContext },
  ): Promise<void> {
    let reference: ReferenceResolution | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      const ref = await r.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
      reference = ref
        ? {
            found: true,
            transaction: ref,
            alreadyReversed: tx.isReversal() ? await r.transactions.hasProcessedReversal(ref.id) : false,
          }
        : { found: false };
    }

    const versionBefore = wallet.version;
    const outcome = settleWagerTransaction({
      wallet,
      transaction: tx,
      reference,
      ledgerEntryId: newId(),
      at: opts.ctx.occurredAt,
    });

    if (opts.isNew) await r.transactions.insert(tx);
    else await r.transactions.update(tx);

    const events: IntegrationEvent<unknown>[] = [];
    switch (outcome.status) {
      case WagerTransactionStatus.Processed:
        if (outcome.ledgerEntry) {
          await r.wallets.update(wallet, versionBefore);
          await r.ledger.insert(outcome.ledgerEntry);
          events.push(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, opts.ctx));
        }
        events.push(WagerTransactionProcessed.from(tx, opts.ctx));
        // Quem estava esperando por esta transação pode tentar já.
        await r.transactions.expediteWaitingFor(tx.providerId, tx.externalTransactionId, opts.ctx.occurredAt);
        break;
      case WagerTransactionStatus.Rejected:
        events.push(WagerTransactionRejected.from(tx, opts.ctx));
        break;
      case WagerTransactionStatus.PendingReference:
        // Evento só na primeira vez; as tentativas seguintes não geram ruído.
        if (opts.isNew) events.push(WagerTransactionPendingReference.from(tx, opts.ctx));
        break;
    }
    await r.outbox.add(events.map((e) => OutboxMessage.enqueue(e)));
  }

  private replay(existing: WagerTransaction, cmd: SubmitWagerCommand): WagerResult {
    if (!existing.matchesPayload(cmd.payloadHash)) {
      this.metrics.increment("wager_idempotency_conflicts_total", { reason: "payload_mismatch" });
      this.logger.warn("idempotency key reused with different payload", {
        correlationId: cmd.correlationId,
        providerId: cmd.providerId,
        transactionId: existing.id,
      });
      throw new IdempotencyConflictError(
        "IDEMPOTENCY_KEY_CONFLICT",
        "Idempotency-Key already used with a different payload",
      );
    }
    this.metrics.increment("wager_duplicates_total", { status: existing.status });
    return toResult(existing, true);
  }

  private ctx(correlationId: string, causationId?: string): EventContext {
    return { correlationId, causationId, occurredAt: this.clock() };
  }
}

export function toResult(tx: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    balance: tx.resultBalance?.toJSON() ?? null,
    idempotentReplay,
  };
}
