import { Body, Controller, Get, Headers, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ProcessWagerTransaction } from "../../application/process-wager-transaction";
import { parseSubmitWager } from "../../application/submit-wager-command";
import { WalletQueries } from "../../application/wallet-queries";
import { AuthGuardPlaceholder } from "./auth.guard";
import { httpStatusFor, presentTransaction } from "./presenters";
import { assertUuid } from "./validation";

/**
 * Entrada HTTP dos provedores. O controller não tem regra de negócio:
 * valida o formato, monta o comando e chama o mesmo use case que o SQS usa.
 */
@Controller()
@UseGuards(AuthGuardPlaceholder)
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: WalletQueries,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const command = parseSubmitWager(body, { idempotencyKey, correlationId });
    const result = await this.processWager.execute(command);
    res.status(httpStatusFor(result));
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  async getById(@Param("transactionId") transactionId: string) {
    return presentTransaction(await this.queries.getTransaction(assertUuid(transactionId, "transactionId")));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return presentTransaction(await this.queries.getTransactionByExternalId(providerId, externalTransactionId));
  }
}
