import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CreateWallet } from "../../application/create-wallet";
import { type FieldError, ValidationError } from "../../application/errors";
import { WalletQueries } from "../../application/wallet-queries";
import { DomainError } from "../../domain/errors";
import { Money } from "../../domain/money";
import { newId } from "../../shared/id";
import { AuthGuardPlaceholder } from "./auth.guard";
import { presentLedgerEntry, presentWallet } from "./presenters";
import { assertUuid } from "./validation";

@Controller("wallets")
@UseGuards(AuthGuardPlaceholder)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly queries: WalletQueries,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Headers("x-correlation-id") correlationId?: string) {
    const b = (body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];

    let playerId = "";
    try {
      playerId = assertUuid(String(b.playerId ?? ""), "playerId");
    } catch (e) {
      if (e instanceof ValidationError) errors.push(...e.details);
      else throw e;
    }

    let initialBalance: Money | undefined;
    try {
      initialBalance = Money.from(b.initialBalance as never);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      errors.push({ field: "initialBalance", message: e.message });
    }
    if (errors.length || !initialBalance) throw new ValidationError(errors);

    const wallet = await this.createWallet.execute({
      playerId,
      initialBalance,
      correlationId: correlationId ?? newId(),
    });
    return presentWallet(wallet);
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    return presentWallet(await this.queries.getWallet(assertUuid(walletId, "walletId")));
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const page = await this.queries.getLedger(assertUuid(walletId, "walletId"), {
      cursor: cursor || undefined,
      limit: limit === undefined ? undefined : Number(limit),
    });
    return { items: page.items.map(presentLedgerEntry), nextCursor: page.nextCursor };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId") walletId: string, @Headers("x-correlation-id") correlationId?: string) {
    return this.queries.reconcile(assertUuid(walletId, "walletId"), correlationId ?? newId());
  }
}
