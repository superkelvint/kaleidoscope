const PERF_DEBUG_FLAG = "__KALEIDOSCOPE_DEBUG_PERF__";
const ROLLING_SAMPLE_COUNT = 120;

/** Development-only rolling timing telemetry shared by rendering stages. */
export function measure(label, work) {
  if (!globalThis[PERF_DEBUG_FLAG]) return work();
  const started = globalThis.performance?.now?.() ?? 0;
  const result = work();
  const elapsed = (globalThis.performance?.now?.() ?? started) - started;
  const timings = globalThis.__KALEIDOSCOPE_PERF_TIMINGS__ ||= {};
  const entry = timings[label] ||= { count: 0, total: 0, samples: [], average: 0, p95: 0, max: 0 };
  entry.count += 1;
  entry.total += elapsed;
  entry.samples.push(elapsed);
  if (entry.samples.length > ROLLING_SAMPLE_COUNT) entry.samples.shift();
  const sorted = [...entry.samples].sort((a, b) => a - b);
  entry.average = entry.samples.reduce((sum, value) => sum + value, 0) / entry.samples.length;
  entry.p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)];
  entry.max = sorted.at(-1);
  if (entry.count % ROLLING_SAMPLE_COUNT === 0) {
    console.debug("[kaleidoscope perf]", label, {
      average: `${entry.average.toFixed(2)}ms`, p95: `${entry.p95.toFixed(2)}ms`, max: `${entry.max.toFixed(2)}ms`, samples: entry.samples.length
    });
  }
  return result;
}
