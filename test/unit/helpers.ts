import { Money } from "../../src/domain/money";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from "../../src/domain/wager-transaction";
import { Wallet } from "../../src/domain/wallet";

export const AT = new Date("2026-01-01T00:00:00.000Z");
export const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
export const WALLET = "0192f291-27dd-7d3f-8071-5f8685deef37";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

let seq = 0;
export const id = () => `id-${++seq}`;

export function wallet(balance: string): Wallet {
  return Wallet.open({
    id: WALLET,
    playerId: PLAYER,
    initialBalance: brl(balance),
    openingTransactionId: id(),
    openingEntryId: id(),
    at: AT,
  }).wallet;
}

export function tx(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const ext = overrides.externalTransactionId ?? `ext-${++seq}`;
  return WagerTransaction.create({
    id: id(),
    providerId: "provider-a",
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    payloadHash: "hash",
    walletId: WALLET,
    playerId: PLAYER,
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl(amount),
    createdAt: AT,
    ...overrides,
  });
}
