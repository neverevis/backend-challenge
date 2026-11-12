import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  api,
  assertLedgerInvariant,
  createWallet,
  openDb,
  resetDatabase,
  startApp,
  submitWager,
  type TestApp,
} from "../support/harness";

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

describe("POST /wallets", () => {
  test("cria wallet com OPENING + CREDIT + eventos na mesma transação", async () => {
    const { walletId } = await createWallet(app.url, "1000.00");
    const [tx] = await db.sql<{ kind: string; status: string }>(
      "SELECT kind, status FROM wager_transactions WHERE wallet_id = ?",
      [walletId],
    );
    expect(tx).toEqual({ kind: "OPENING", status: "PROCESSED" });
    const events = await db.sql<{ event_type: string }>(
      "SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY seq",
      [walletId],
    );
    expect(events.map((e) => e.event_type)).toEqual(["WalletBalanceChanged", "WagerTransactionProcessed"]);
    expect(await assertLedgerInvariant(db.sql, walletId)).toEqual({ balance: "1000.00", entries: 1 });
  });

  test("duplicada para o mesmo player + moeda é 409", async () => {
    const { playerId } = await createWallet(app.url, "1.00");
    const res = await api(app.url, "POST", "/wallets", {
      playerId,
      initialBalance: { amount: "1.00", currency: "BRL" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test("mesmo player pode ter wallet em outra moeda", async () => {
    const { playerId } = await createWallet(app.url, "1.00");
    const res = await api(app.url, "POST", "/wallets", {
      playerId,
      initialBalance: { amount: "1.00", currency: "USD" },
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /wagering/transactions", () => {
  test("replay devolve o resultado original, inclusive o saldo daquele momento", async () => {
    const w = await createWallet(app.url, "100.00");
    const first = await submitWager(app.url, { ...w, externalTransactionId: "replay-1", kind: "BET", amount: "30.00" });
    await submitWager(app.url, { ...w, externalTransactionId: "replay-2", kind: "BET", amount: "10.00" });
    const again = await submitWager(app.url, { ...w, externalTransactionId: "replay-1", kind: "BET", amount: "30.00" });

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(again.body.balance.amount).toBe("70.00"); // não o saldo atual (60.00)
  });

  test("mesma key com payload diferente é 409 e não altera nada", async () => {
    const w = await createWallet(app.url, "100.00");
    await submitWager(app.url, { ...w, externalTransactionId: "conflict-1", kind: "BET", amount: "10.00" });
    const res = await submitWager(app.url, { ...w, externalTransactionId: "conflict-1", kind: "BET", amount: "11.00" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect((await assertLedgerInvariant(db.sql, w.walletId)).balance).toBe("90.00");
  });

  test("mesmo externalTransactionId com outra key é 409", async () => {
    const w = await createWallet(app.url, "100.00");
    await submitWager(app.url, { ...w, externalTransactionId: "ext-dup", kind: "BET", amount: "10.00" });
    const res = await submitWager(app.url, {
      ...w,
      externalTransactionId: "ext-dup",
      kind: "BET",
      amount: "10.00",
      idempotencyKey: "outra-chave",
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EXTERNAL_TRANSACTION_ID_CONFLICT");
  });

  test("status HTTP distinguem as categorias", async () => {
    const w = await createWallet(app.url, "10.00");
    const ok = await submitWager(app.url, { ...w, externalTransactionId: "s-1", kind: "BET", amount: "5.00" });
    const rejected = await submitWager(app.url, { ...w, externalTransactionId: "s-2", kind: "BET", amount: "50.00" });
    const pending = await submitWager(app.url, {
      ...w,
      externalTransactionId: "s-3",
      kind: "REFUND",
      amount: "5.00",
      referenceExternalTransactionId: "nao-existe",
    });
    const invalid = await submitWager(app.url, { ...w, externalTransactionId: "s-4", kind: "OPENING", amount: "5.00" });
    const noKey = await api(app.url, "POST", "/wagering/transactions", {});

    expect([ok.status, rejected.status, pending.status, invalid.status, noKey.status]).toEqual([
      200, 422, 202, 400, 400,
    ]);
    expect(rejected.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(pending.body.status).toBe("PENDING_REFERENCE");
  });

  test("ciclo BET → WIN → ROLLBACK do WIN mantém o ledger consistente", async () => {
    const w = await createWallet(app.url, "100.00");
    await submitWager(app.url, { ...w, externalTransactionId: "c-bet", kind: "BET", amount: "20.00" });
    await submitWager(app.url, {
      ...w,
      externalTransactionId: "c-win",
      kind: "WIN",
      amount: "50.00",
      referenceExternalTransactionId: "c-bet",
    });
    await submitWager(app.url, { ...w, externalTransactionId: "c-loss", kind: "LOSS", amount: "20.00" });
    const rb = await submitWager(app.url, {
      ...w,
      externalTransactionId: "c-rb",
      kind: "ROLLBACK",
      amount: "50.00",
      referenceExternalTransactionId: "c-win",
    });
    expect(rb.body.status).toBe("PROCESSED");
    // 100 - 20 + 50 - 50 = 80; LOSS não gera lançamento.
    expect(await assertLedgerInvariant(db.sql, w.walletId)).toEqual({ balance: "80.00", entries: 4 });
  });

  test("wallet inexistente é rejeitada de forma determinística", async () => {
    const res = await submitWager(app.url, {
      walletId: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      externalTransactionId: "no-wallet",
      kind: "BET",
      amount: "1.00",
    });
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe("WALLET_NOT_FOUND");
  });
});

describe("consultas e reconciliação", () => {
  test("ledger paginado por cursor opaco e estável", async () => {
    const w = await createWallet(app.url, "100.00");
    for (let i = 0; i < 5; i++) {
      await submitWager(app.url, { ...w, externalTransactionId: `page-${i}`, kind: "BET", amount: "1.00" });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await api(app.url, "GET", `/wallets/${w.walletId}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(6); // OPENING + 5 BETs
    expect(new Set(seen).size).toBe(6);

    const bad = await api(app.url, "GET", `/wallets/${w.walletId}/ledger?cursor=lixo`);
    expect(bad.status).toBe(400);
  });

  test("reconciliação consistente", async () => {
    const w = await createWallet(app.url, "100.00");
    await submitWager(app.url, { ...w, externalTransactionId: "rec-1", kind: "BET", amount: "25.00" });
    const res = await api(app.url, "POST", `/wallets/${w.walletId}/reconciliation`);
    expect(res.body).toEqual({
      walletId: w.walletId,
      storedBalance: { amount: "75.00", currency: "BRL" },
      calculatedBalance: { amount: "75.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("GET por id interno e por (provider, externalId)", async () => {
    const w = await createWallet(app.url, "10.00");
    const sub = await submitWager(app.url, { ...w, externalTransactionId: "get-1", kind: "BET", amount: "1.00" });
    const byId = await api(app.url, "GET", `/wagering/transactions/${sub.body.transactionId}`);
    const byExt = await api(app.url, "GET", `/providers/provider-a/wagering/transactions/get-1`);
    expect(byId.body).toEqual(byExt.body);
    expect(byId.body.status).toBe("PROCESSED");
  });
});
