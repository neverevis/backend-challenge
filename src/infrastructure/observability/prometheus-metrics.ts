import { type Metrics } from "../../application/ports/observability";

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

const key = (name: string, labels: Record<string, string> = {}) => {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, "_")}"`);
  return parts.length ? `${name}{${parts.join(",")}}` : name;
};

/**
 * Métricas em memória no formato texto do Prometheus (GET /metrics).
 * São por instância — o Prometheus agrega entre instâncias. Não guardam
 * nenhum estado de negócio, então perdê-las num restart é aceitável.
 */
export class PrometheusMetrics implements Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, { name: string; labels: Record<string, string>; h: Histogram }>();

  increment(name: string, labels?: Record<string, string>, value = 1) {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + value);
  }

  gauge(name: string, value: number, labels?: Record<string, string>) {
    this.gauges.set(key(name, labels), value);
  }

  observe(name: string, valueSeconds: number, labels: Record<string, string> = {}) {
    const k = key(name, labels);
    let entry = this.histograms.get(k);
    if (!entry) {
      entry = { name, labels, h: { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 } };
      this.histograms.set(k, entry);
    }
    BUCKETS.forEach((b, i) => {
      if (valueSeconds <= b) entry.h.buckets[i]! += 1;
    });
    entry.h.sum += valueSeconds;
    entry.h.count += 1;
  }

  /** Lê um contador (usado nos testes). */
  value(name: string, labels?: Record<string, string>): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [k, v] of this.gauges) lines.push(`${k} ${v}`);
    for (const { name, labels, h } of this.histograms.values()) {
      BUCKETS.forEach((b, i) => lines.push(`${key(`${name}_bucket`, { ...labels, le: String(b) })} ${h.buckets[i]}`));
      lines.push(`${key(`${name}_bucket`, { ...labels, le: "+Inf" })} ${h.count}`);
      lines.push(`${key(`${name}_sum`, labels)} ${h.sum}`);
      lines.push(`${key(`${name}_count`, labels)} ${h.count}`);
    }
    return lines.sort().join("\n") + "\n";
  }
}
