/** Campos de contexto permitidos nos logs. Nunca payloads financeiros completos. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface Logger {
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

export interface Metrics {
  increment(name: string, labels?: Record<string, string>, value?: number): void;
  observe(name: string, valueSeconds: number, labels?: Record<string, string>): void;
}

export const LOGGER = Symbol("Logger");
export const METRICS = Symbol("Metrics");
