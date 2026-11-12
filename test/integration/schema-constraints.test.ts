import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWallet, openDb, resetDatabase, startApp, submitWager, type TestApp } from "../support/harness";

/**
 * As garantias valem no banco mesmo se o código de aplicação errar:
 * estes testes tentam violá-las com SQL direto.
 */
let app: TestApp;
let db: Awaited<ReturnType<typeof openDb>>;
let walletId: string;

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  db = await openDb();
  const w = await createWallet(app.url, "100.00");
  walletId = w.walletId;
  await submitWager(app.url, { ...w, externalTransactionId: "c-1", kind: "BET", amount: "10.00" });
});
afterAll(async () => {
  await app?.close();
  await db?.close();
});

const rejects = (q: string, p: unknown[] = []) => expect(db.sql(q, p)).rejects.toThrow();

describe("constraints do schema", () => {
  test("ledger é append-only: UPDATE, DELETE e TRUNCATE falham", async () => {
    await rejects("UPDATE wallet_ledger_entries SET amount = amount + 1");
    await rejects("DELETE FROM wallet_ledger_entries");
    await rejects("TRUNCATE wallet_ledger_entries");
  });

  test("saldo negativo é barrado pelo CHECK", async () => {
    await rejects("UPDATE wallets SET balance_amount = -1, version = version + 1 WHERE id = ?", [walletId]);
  });

  test("mudar saldo sem lançamento correspondente falha no COMMIT", async () => {
    await rejects("UPDATE wallets SET balance_amount = 1000, version = version + 1 WHERE id = ?", [walletId]);
  });

  test("mudar saldo sem incrementar a versão falha", async () => {
    await rejects("UPDATE wallets SET balance_amount = 95 WHERE id = ?", [walletId]);
  });

  test("transação terminal não pode mudar de estado nem ser apagada", async () => {
    await rejects("UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE status = 'PROCESSED'");
    await rejects("DELETE FROM wager_transactions");
  });

  test("idempotency key única por provider", async () => {
    await rejects(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
          round_id, game_id, kind, amount, currency, status, created_at, updated_at)
       SELECT gen_random_uuid(), provider_id, 'outro-ext', idempotency_key, payload_hash, wallet_id, player_id,
              round_id, game_id, kind, amount, currency, 'PENDING', now(), now()
         FROM wager_transactions WHERE external_transaction_id = 'c-1'`,
    );
  });

  test("lançamento para transação inexistente ou não processada falha", async () => {
    await rejects(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
         balance_before_amount, balance_after_amount, created_at)
       VALUES (gen_random_uuid(), ?, gen_random_uuid(), 'CREDIT', 1, 'BRL', 0, 1, now())`,
      [walletId],
    );
  });

  test("lançamento com aritmética errada falha", async () => {
    await rejects(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
         balance_before_amount, balance_after_amount, created_at)
       SELECT gen_random_uuid(), wallet_id, id, 'CREDIT', amount, currency, 0, 999, now()
         FROM wager_transactions WHERE external_transaction_id = 'c-1'`,
    );
  });
});
