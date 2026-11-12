import { WagerTransactionProcessed, WalletBalanceChanged } from "../domain/events/wager-events";
import { type EventContext } from "../domain/events/integration-event";
import { Money } from "../domain/money";
import { OutboxMessage } from "../domain/outbox-message";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { newId } from "../shared/id";
import { UniqueViolationError, WalletAlreadyExistsError } from "./errors";
import { sha256Hex } from "./payload-hash";
import { type Logger, type Metrics } from "./ports/observability";
import { type UnitOfWork } from "./ports/repositories";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

/**
 * Cria a wallet. Saldo inicial > 0 gera a transação interna OPENING e o
 * lançamento CREDIT na mesma transação SQL. Duplicata (player + moeda) é
 * barrada pela UNIQUE do banco, não por um SELECT prévio.
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async execute(cmd: CreateWalletCommand): Promise<Wallet> {
    const at = new Date();
    const walletId = newId();
    const openingTransactionId = newId();

    try {
      const wallet = await this.uow.transaction(async (r) => {
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: cmd.playerId,
          initialBalance: cmd.initialBalance,
          openingTransactionId,
          openingEntryId: newId(),
          at,
        });
        await r.wallets.insert(wallet);

        if (openingEntry) {
          const opening = WagerTransaction.opening({
            id: openingTransactionId,
            walletId,
            playerId: cmd.playerId,
            money: cmd.initialBalance,
            payloadHash: sha256Hex({ walletId, playerId: cmd.playerId, money: cmd.initialBalance.toJSON() }),
            createdAt: at,
          });
          opening.markProcessed(undefined, at, wallet.balance);
          await r.transactions.insert(opening);
          await r.ledger.insert(openingEntry);

          const ctx: EventContext = { correlationId: cmd.correlationId, occurredAt: at };
          await r.outbox.add([
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx)),
            OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx)),
          ]);
        }
        return wallet;
      });
      this.metrics.increment("wallets_created_total");
      this.logger.info("wallet created", { correlationId: cmd.correlationId, walletId });
      return wallet;
    } catch (e) {
      if (e instanceof UniqueViolationError && e.constraint === "wallets_player_currency_key") {
        throw new WalletAlreadyExistsError(
          `Player already has a ${cmd.initialBalance.currency} wallet`,
        );
      }
      throw e;
    }
  }
}
