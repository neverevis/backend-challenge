import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { SQS_CLIENT } from "../../infrastructure/sqs/sqs.client";
import { config } from "../../config";

/** Health checks. Abertos, sem autenticação (README seção 2). */
@Controller("health")
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  /** Liveness: o processo está de pé. Não toca dependências externas. */
  @Get("live")
  @HttpCode(200)
  live() {
    return { status: "ok" };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. 503 se algum falhar. */
  @Get("ready")
  async ready() {
    const [postgres, sqs] = await Promise.all([
      this.check(() => this.orm.em.getConnection().execute("select 1")),
      this.check(() => this.sqs.send(new GetQueueUrlCommand({ QueueName: config.sqs.queueName }))),
    ]);
    const body = { status: postgres && sqs ? "ok" : "unavailable", checks: { postgres, sqs } };
    if (body.status !== "ok") throw new ServiceUnavailableException(body);
    return body;
  }

  private async check(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]);
      return true;
    } catch {
      return false;
    }
  }
}
