import { DomainError } from "../domain/errors";
import { Money } from "../domain/money";
import { EXTERNAL_KINDS, WagerTransactionKind } from "../domain/wager-transaction";
import { type FieldError, ValidationError } from "./errors";
import { sha256Hex } from "./payload-hash";

/** Comando de submissão, igual para HTTP e SQS. */
export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  payloadHash: string;
  correlationId: string;
  causationId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ID_LENGTH = 128;

/**
 * Campos de negócio que entram no payloadHash. Header, correlationId e
 * metadados de transporte ficam de fora (README seção 9).
 * O `money.amount` entra normalizado ("25" e "25.00" são o mesmo valor).
 */
export function computeWagerPayloadHash(c: Omit<SubmitWagerCommand, "payloadHash" | "correlationId" | "causationId" | "idempotencyKey">): string {
  return sha256Hex({
    providerId: c.providerId,
    externalTransactionId: c.externalTransactionId,
    playerId: c.playerId,
    walletId: c.walletId,
    roundId: c.roundId,
    gameId: c.gameId,
    kind: c.kind,
    money: c.money.toJSON(),
    referenceExternalTransactionId: c.referenceExternalTransactionId ?? null,
  });
}

/**
 * Valida e converte o corpo recebido (unknown) em comando.
 * Acumula todos os erros de campo para devolver de uma vez.
 */
export function parseSubmitWager(
  body: unknown,
  meta: { idempotencyKey: unknown; correlationId?: string; causationId?: string },
): SubmitWagerCommand {
  const errors: FieldError[] = [];
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    errors.push({ field: "body", message: "must be a JSON object" });
  }

  const str = (field: string, value: unknown, opts: { uuid?: boolean; max?: number } = {}) => {
    if (typeof value !== "string" || value.trim() === "") {
      errors.push({ field, message: "is required and must be a non-empty string" });
      return "";
    }
    if (value.length > (opts.max ?? MAX_ID_LENGTH)) {
      errors.push({ field, message: `must have at most ${opts.max ?? MAX_ID_LENGTH} characters` });
    }
    if (opts.uuid && !UUID.test(value)) errors.push({ field, message: "must be a UUID" });
    return value;
  };

  const idempotencyKey = str("Idempotency-Key", meta.idempotencyKey, { max: 255 });
  const providerId = str("providerId", b.providerId);
  const externalTransactionId = str("externalTransactionId", b.externalTransactionId);
  const playerId = str("playerId", b.playerId, { uuid: true });
  const walletId = str("walletId", b.walletId, { uuid: true });
  const roundId = str("roundId", b.roundId);
  const gameId = str("gameId", b.gameId);

  let kind = b.kind as WagerTransactionKind;
  if (!(EXTERNAL_KINDS as readonly unknown[]).includes(b.kind)) {
    errors.push({ field: "kind", message: `must be one of ${EXTERNAL_KINDS.join(", ")}` });
    kind = WagerTransactionKind.Bet;
  }

  let reference: string | undefined;
  if (b.referenceExternalTransactionId !== undefined && b.referenceExternalTransactionId !== null) {
    reference = str("referenceExternalTransactionId", b.referenceExternalTransactionId);
  }
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !reference) {
    errors.push({ field: "referenceExternalTransactionId", message: `is required for ${kind}` });
  }
  if (kind === WagerTransactionKind.Bet && reference) {
    errors.push({ field: "referenceExternalTransactionId", message: "is not allowed for BET" });
  }

  let money: Money | undefined;
  try {
    money = Money.from(b.money as never);
    if (!money.isPositive()) errors.push({ field: "money.amount", message: "must be greater than zero" });
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    errors.push({ field: "money", message: e.message });
  }

  if (errors.length > 0 || !money) throw new ValidationError(errors);

  const fields = {
    providerId,
    externalTransactionId,
    playerId: playerId.toLowerCase(),
    walletId: walletId.toLowerCase(),
    roundId,
    gameId,
    kind,
    money,
    referenceExternalTransactionId: reference,
  };
  return {
    ...fields,
    idempotencyKey,
    payloadHash: computeWagerPayloadHash(fields),
    correlationId: meta.correlationId ?? idempotencyKey,
    causationId: meta.causationId,
  };
}
