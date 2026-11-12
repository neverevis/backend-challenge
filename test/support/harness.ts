import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../../src/app.module";
import mikroOrmConfig from "../../src/infrastructure/database/mikro-orm.config";

process.env.LOG_LEVEL = "silent";

/** Apaga o schema e roda as migrations do zero (Postgres real, nada mockado). */
export async function resetDatabase(): Promise<void> {
  const orm = await MikroORM.init({ ...mikroOrmConfig, pool: { min: 0, max: 2 } });
  try {
    await orm.em.getConnection().execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await orm.getMigrator().up();
  } finally {
    await orm.close();
  }
}

/** Conexão direta para inspecionar o banco nos testes. */
export async function openDb(): Promise<{ sql: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T[]>; close: () => Promise<void> }> {
  const orm = await MikroORM.init({ ...mikroOrmConfig, pool: { min: 0, max: 5 } });
  return {
    sql: <T>(q: string, p: unknown[] = []) => orm.em.fork().execute(q, p) as Promise<T[]>,
    close: () => orm.close(),
  };
}

export interface TestApp {
  url: string;
  app: INestApplication;
  close: () => Promise<void>;
}

/** Sobe a aplicação Nest de verdade numa porta aleatória. */
export async function startApp(): Promise<TestApp> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, app, close: () => app.close() };
}

// ---------------------------------------------------------------- client

export const PROVIDER = "provider-a";

export async function api(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

export async function createWallet(base: string, balance: string, playerId = crypto.randomUUID()) {
  const res = await api(base, "POST", "/wallets", {
    playerId,
    initialBalance: { amount: balance, currency: "BRL" },
  });
  if (res.status !== 201) throw new Error(`createWallet failed: ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id as string, playerId };
}

export interface WagerInput {
  walletId: string;
  playerId: string;
  externalTransactionId: string;
  kind: string;
  amount: string;
  roundId?: string;
  referenceExternalTransactionId?: string;
  idempotencyKey?: string;
}

export function submitWager(base: string, w: WagerInput) {
  return api(
    base,
    "POST",
    "/wagering/transactions",
    {
      providerId: PROVIDER,
      externalTransactionId: w.externalTransactionId,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: w.roundId ?? "round-1",
      gameId: "fortune-chimp",
      kind: w.kind,
      money: { amount: w.amount, currency: "BRL" },
      ...(w.referenceExternalTransactionId
        ? { referenceExternalTransactionId: w.referenceExternalTransactionId }
        : {}),
    },
    { "Idempotency-Key": w.idempotencyKey ?? `${PROVIDER}:${w.externalTransactionId}` },
  );
}

/**
 * Invariante final de todos os testes (README 13):
 * wallet.balance == saldo reconstruído pelo ledger, e a cadeia de lançamentos fecha.
 */
export async function assertLedgerInvariant(
  sql: Awaited<ReturnType<typeof openDb>>["sql"],
  walletId: string,
): Promise<{ balance: string; entries: number }> {
  const [row] = await sql<{ balance: string; ledger: string; entries: number; broken: number }>(
    `SELECT w.balance_amount::text AS balance,
            COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS ledger,
            COUNT(l.id)::int AS entries,
            (SELECT COUNT(*)::int FROM (
               SELECT balance_before_amount, LAG(balance_after_amount) OVER (ORDER BY seq) AS prev_after
                 FROM wallet_ledger_entries WHERE wallet_id = w.id
             ) c WHERE prev_after IS NOT NULL AND prev_after <> balance_before_amount) AS broken
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ? GROUP BY w.id`,
    [walletId],
  );
  if (!row) throw new Error(`wallet ${walletId} not found`);
  if (row.balance !== row.ledger) throw new Error(`Invariant broken: balance ${row.balance} != ledger ${row.ledger}`);
  if (row.broken !== 0) throw new Error(`Ledger chain broken in ${row.broken} entries`);
  return { balance: row.balance, entries: row.entries };
}
