import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  assertLedgerInvariant,
  createWallet,
  openDb,
  resetDatabase,
  startApp,
  submitWager,
  type TestApp,
} from "../support/harness";

/** Paralelismo real: requisições HTTP simultâneas, cada uma em sua conexão do pool. */
let app: TestApp;
let db: Awaited<ReturnType<typeof openDb>>;

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  db = await openDb();
});
afterAll(async () => {
  await app?.close();
  await db?.close();
});

const debits = async (walletId: string) =>
  (await db.sql<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
    [walletId],
  ))[0]!.n;

describe("concorrência numa instância", () => {
  test("cenário obrigatório: saldo 100, duas apostas de 80 simultâneas", async () => {
    const w = await createWallet(app.url, "100.00");
    const results = await Promise.all([
      submitWager(app.url, { ...w, externalTransactionId: "race-a", kind: "BET", amount: "80.00" }),
      submitWager(app.url, { ...w, externalTransactionId: "race-b", kind: "BET", amount: "80.00" }),
    ]);
    const statuses = results.map((r) => r.body.status).sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    expect(results.find((r) => r.body.status === "REJECTED")!.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(await debits(w.walletId)).toBe(1);
    expect((await assertLedgerInvariant(db.sql, w.walletId)).balance).toBe("20.00");

    // Retries das duas não duplicam o débito.
    await Promise.all([
      submitWager(app.url, { ...w, externalTransactionId: "race-a", kind: "BET", amount: "80.00" }),
      submitWager(app.url, { ...w, externalTransactionId: "race-b", kind: "BET", amount: "80.00" }),
    ]);
    expect(await debits(w.walletId)).toBe(1);
  });

  test("a mesma aposta enviada 50 vezes em paralelo gera um único débito", async () => {
    const w = await createWallet(app.url, "100.00");
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        submitWager(app.url, { ...w, externalTransactionId: "same-bet", kind: "BET", amount: "10.00" }),
      ),
    );
    expect(results.every((r) => r.status === 200 && r.body.status === "PROCESSED")).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.body.balance.amount === "90.00")).toBe(true);
    expect(await debits(w.walletId)).toBe(1);
    expect((await assertLedgerInvariant(db.sql, w.walletId)).balance).toBe("90.00");
  });

  test("hot wallet: 40 apostas distintas de 5.00 disputando 100.00", async () => {
    const w = await createWallet(app.url, "100.00");
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        submitWager(app.url, { ...w, externalTransactionId: `hot-${i}`, kind: "BET", amount: "5.00" }),
      ),
    );
    const processed = results.filter((r) => r.body.status === "PROCESSED").length;
    const rejected = results.filter((r) => r.body.failureCode === "INSUFFICIENT_FUNDS").length;
    expect(processed).toBe(20);
    expect(rejected).toBe(20);
    expect((await assertLedgerInvariant(db.sql, w.walletId)).balance).toBe("0.00");
  });

  test("wallets distintas são processadas em paralelo sem interferência", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(app.url, "50.00")));
    await Promise.all(
      wallets.flatMap((w, wi) =>
        Array.from({ length: 5 }, (_, i) =>
          submitWager(app.url, { ...w, externalTransactionId: `multi-${wi}-${i}`, kind: "BET", amount: "10.00" }),
        ),
      ),
    );
    for (const w of wallets) {
      expect(await assertLedgerInvariant(db.sql, w.walletId)).toEqual({ balance: "0.00", entries: 6 });
    }
  });

  test("REFUND e ROLLBACK concorrentes da mesma BET: só uma reversão", async () => {
    const w = await createWallet(app.url, "100.00");
    await submitWager(app.url, { ...w, externalTransactionId: "rev-bet", kind: "BET", amount: "40.00" });
    const results = await Promise.all([
      submitWager(app.url, { ...w, externalTransactionId: "rev-refund", kind: "REFUND", amount: "40.00", referenceExternalTransactionId: "rev-bet" }),
      submitWager(app.url, { ...w, externalTransactionId: "rev-rollback", kind: "ROLLBACK", amount: "40.00", referenceExternalTransactionId: "rev-bet" }),
    ]);
    expect(results.map((r) => r.body.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect(results.find((r) => r.body.status === "REJECTED")!.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    expect((await assertLedgerInvariant(db.sql, w.walletId)).balance).toBe("100.00");
  });
});
