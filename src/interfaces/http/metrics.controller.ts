import { Controller, Get, Header, Inject } from "@nestjs/common";
import { METRICS } from "../../application/ports/observability";
import { PrometheusMetrics } from "../../infrastructure/observability/prometheus-metrics";

/** Métricas no formato texto do Prometheus. */
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4")
  render() {
    return this.metrics.render();
  }
}
