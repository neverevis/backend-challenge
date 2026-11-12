import { type LogContext, type Logger } from "../../application/ports/observability";

/** Logger estruturado: uma linha JSON por evento, em stdout. */
export class JsonLogger implements Logger {
  constructor(private readonly base: Record<string, string> = {}) {}

  info(msg: string, ctx?: LogContext) {
    this.write("info", msg, ctx);
  }
  warn(msg: string, ctx?: LogContext) {
    this.write("warn", msg, ctx);
  }
  error(msg: string, ctx?: LogContext) {
    this.write("error", msg, ctx);
  }

  private write(level: string, msg: string, ctx?: LogContext) {
    if (process.env.LOG_LEVEL === "silent") return;
    const line = { ts: new Date().toISOString(), level, msg, ...this.base, ...ctx };
    process.stdout.write(JSON.stringify(line) + "\n");
  }
}
