import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "./application/create-wallet";
import { LOGGER, type Logger, METRICS, type Metrics } from "./application/ports/observability";
import { UNIT_OF_WORK, type UnitOfWork } from "./application/ports/repositories";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { WalletQueries } from "./application/wallet-queries";
import mikroOrmConfig from "./infrastructure/database/mikro-orm.config";
import { PgUnitOfWork } from "./infrastructure/database/pg-unit-of-work";
import { JsonLogger } from "./infrastructure/observability/json-logger";
import { PrometheusMetrics } from "./infrastructure/observability/prometheus-metrics";
import { createSqsClient, SQS_CLIENT } from "./infrastructure/sqs/sqs.client";
import { AuthGuardPlaceholder } from "./interfaces/http/auth.guard";
import { ErrorFilter } from "./interfaces/http/error.filter";
import { HealthController } from "./interfaces/http/health.controller";
import { MetricsController } from "./interfaces/http/metrics.controller";
import { WageringController } from "./interfaces/http/wagering.controller";
import { WalletsController } from "./interfaces/http/wallets.controller";

/**
 * Composição da aplicação. As classes de `application/` não usam decorators
 * do Nest: são montadas aqui com `useFactory`, recebendo as portas.
 */
@Module({
  imports: [MikroOrmModule.forRoot({ ...mikroOrmConfig, registerRequestContext: false })],
  controllers: [HealthController, MetricsController, WalletsController, WageringController],
  providers: [
    { provide: SQS_CLIENT, useFactory: createSqsClient },
    { provide: LOGGER, useFactory: () => new JsonLogger({ service: "wagering-processor" }) },
    { provide: METRICS, useFactory: () => new PrometheusMetrics() },
    { provide: UNIT_OF_WORK, useFactory: (orm: MikroORM) => new PgUnitOfWork(orm), inject: [MikroORM] },
    {
      provide: ProcessWagerTransaction,
      useFactory: (uow: UnitOfWork, logger: Logger, metrics: Metrics) =>
        new ProcessWagerTransaction(uow, logger, metrics),
      inject: [UNIT_OF_WORK, LOGGER, METRICS],
    },
    {
      provide: CreateWallet,
      useFactory: (uow: UnitOfWork, logger: Logger, metrics: Metrics) => new CreateWallet(uow, logger, metrics),
      inject: [UNIT_OF_WORK, LOGGER, METRICS],
    },
    {
      provide: WalletQueries,
      useFactory: (uow: UnitOfWork, logger: Logger, metrics: Metrics) => new WalletQueries(uow, logger, metrics),
      inject: [UNIT_OF_WORK, LOGGER, METRICS],
    },
    AuthGuardPlaceholder,
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
