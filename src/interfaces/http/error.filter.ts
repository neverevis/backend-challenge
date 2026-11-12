import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  ApplicationError,
  IdempotencyConflictError,
  NotFoundError,
  TransientInfrastructureError,
  ValidationError,
  WalletAlreadyExistsError,
} from "../../application/errors";
import { LOGGER, type Logger } from "../../application/ports/observability";
import { DomainError } from "../../domain/errors";

/**
 * Mapeamento único de erros → HTTP, igual para todos os endpoints:
 *
 *   400  payload inválido                       (corrigir antes de reenviar)
 *   404  recurso não encontrado
 *   409  conflito de idempotência / duplicata   (não é replay)
 *   503  falha transitória de infraestrutura    (reenviar com a mesma key)
 *   500  erro inesperado
 *
 * Rejeição por regra de negócio (422) e aceite pendente (202) não são erros:
 * vêm do resultado do use case (ver presenters.ts).
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const [status, body] = this.map(e);

    if (status >= 500) {
      this.logger.error("request failed", {
        correlationId: req.header("x-correlation-id") ?? req.header("idempotency-key"),
        path: req.path,
        status,
        error: e instanceof Error ? e.name : "unknown",
        detail: e instanceof Error ? e.message : undefined,
      });
    }
    if (status === 503) res.setHeader("Retry-After", "1");
    res.status(status).json(body);
  }

  private map(e: unknown): [number, { error: Record<string, unknown> }] {
    const err = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
      error: { code, message, ...extra },
    });

    if (e instanceof ValidationError) return [400, err(e.code, "Invalid request", { details: e.details })];
    if (e instanceof DomainError) return [400, err(e.code, e.message)];
    if (e instanceof NotFoundError) return [404, err(e.code, e.message)];
    if (e instanceof IdempotencyConflictError || e instanceof WalletAlreadyExistsError) {
      return [409, err(e.code, e.message)];
    }
    if (e instanceof TransientInfrastructureError) {
      return [503, err(e.code, "Temporarily unavailable, retry with the same Idempotency-Key")];
    }
    if (e instanceof ApplicationError) return [500, err(e.code, "Internal error")];
    if (e instanceof HttpException) {
      const status = e.getStatus();
      // JSON malformado vira 400 do body-parser; rota inexistente vira 404.
      return [status, err(status === 400 ? "VALIDATION_ERROR" : "HTTP_ERROR", e.message)];
    }
    if (isBodyParserError(e)) return [400, err("VALIDATION_ERROR", "Malformed JSON body")];
    if (isConnectionError(e)) return [503, err("TRANSIENT_INFRASTRUCTURE_ERROR", "Database unavailable")];
    return [500, err("INTERNAL_ERROR", "Internal error")];
  }
}

function isBodyParserError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { type?: string }).type === "entity.parse.failed";
}

function isConnectionError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? "";
  const code = (e as { code?: string })?.code ?? "";
  return name === "ConnectionException" || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(code);
}
