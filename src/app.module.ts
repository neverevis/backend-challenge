import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import mikroOrmConfig from "./infrastructure/database/mikro-orm.config";
import { createSqsClient, SQS_CLIENT } from "./infrastructure/sqs/sqs.client";
import { HealthController } from "./interfaces/http/health.controller";

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [HealthController],
  providers: [{ provide: SQS_CLIENT, useFactory: createSqsClient }],
})
export class AppModule {}
