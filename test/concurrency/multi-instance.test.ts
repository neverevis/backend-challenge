import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { assertLedgerInvariant, createWallet, openDb, resetDatabase, submitWager } from "../support/harness";

/**
 * Três PROCESSOS separados da aplicação (não três instâncias no mesmo
 * processo), cada um com seu pool de conexões, sobre o mesmo Postgres.
 * Nenhum estado em memória é compartilhado: só o banco garante a correção.
 */
const PORTS = [3101, 3102, 3103];
let procs: Subprocess[] = [];
let db: Awaited<ReturnType<typeof openDb>>;
const urls = PORTS.map((p) => `http://127.0.0.1:${p}`);

async function waitLive(url: string) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health/live`)).ok) return;
    } catch {
      /* ainda subindo */
    }
    await Bun.sleep(100);
  }
  throw new Error(`instance ${url} did not start`);
}

beforeAll(async () => {
  await resetDatabase();
  db = await openDb();
  procs = PORTS.map((port) =>
    Bun.spawn(["bun", "run", "src/main.ts"], {
      env: { ...process.env, PORT: String(port), LOG_LEVEL: "silent" },
      stdout: "ignore",
      stderr: "inherit",
    }),
  );
  await Promise.all(urls.map(waitLive));
}, 30_000);

afterAll(async () => {
  procs.forEach((p) => p.kill());
  await Promise.all(procs.map((p) => p.exited));
  await db?.close();
});

describe("≥ 3 instâncias simultâneas", () => {
  test("cenário 100 / 2×80 com cada aposta numa instância diferente", async () => {
    const w = await createWallet(urls[0]!, "100.00");
    const results = await Promise.all([
      submitWager(urls[1]!, { ...w, externalTransactionId: "mi-a", kind: "BET", amount: "80.00" }),
      submitWager(urls[2]!, { ...w, externalTransactionId: "mi-b", kind: "BET", amount: "80.00" }),
    ]);
    expect(results.map((r) => r.body.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect((await assertLedgerInvariant(db.sql, w.walletId)).balance).toBe("20.00");
  });

  test("mesma aposta 60× espalhada pelas 3 instâncias: um débito", async () => {
    const w = await createWallet(urls[0]!, "100.00");
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        submitWager(urls[i % 3]!, { ...w, externalTransactionId: "mi-same", kind: "BET", amount: "7.00" }),
      ),
    );
    expect(results.every((r) => r.body.status === "PROCESSED")).toBe(true);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(await assertLedgerInvariant(db.sql, w.walletId)).toEqual({ balance: "93.00", entries: 2 });
  });

  test("hot wallet disputada por 3 instâncias nunca fica negativa", async () => {
    const w = await createWallet(urls[0]!, "50.00");
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        submitWager(urls[i % 3]!, { ...w, externalTransactionId: `mi-hot-${i}`, kind: "BET", amount: "3.00" }),
      ),
    );
    // 50 / 3 = 16 apostas cabem, sobram 2.00.
    expect(results.filter((r) => r.body.status === "PROCESSED")).toHaveLength(16);
    expect((await assertLedgerInvariant(db.sql, w.walletId)).balance).toBe("2.00");
  });
});
