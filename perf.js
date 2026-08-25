const PERF_DEBUG_FLAG = "__KALEIDOSCOPE_DEBUG_PERF__";
const ROLLING_SAMPLE_COUNT = 120;

/** Development-only rolling timing telemetry shared by rendering stages. */
function debugEnabled() { return Boolean(globalThis[PERF_DEBUG_FLAG]); }
function sampleMetadata(metadata) { return typeof metadata === "function" ? metadata() : metadata; }

/** Records a debug-only event/counter alongside the rolling timings. */
export function count(label, metadata) {
  if (!debugEnabled()) return;
  const counters = globalThis.__KALEIDOSCOPE_PERF_COUNTERS__ ||= {};
  const entry = counters[label] ||= { count: 0, samples: [] };
  entry.count += 1;
  entry.samples.push(sampleMetadata(metadata));
  if (entry.samples.length > ROLLING_SAMPLE_COUNT) entry.samples.shift();
}

export function measure(label, work, metadata) {
  if (!debugEnabled()) return work();
  const started = globalThis.performance?.now?.() ?? 0;
  const result = work();
  const elapsed = (globalThis.performance?.now?.() ?? started) - started;
  const timings = globalThis.__KALEIDOSCOPE_PERF_TIMINGS__ ||= {};
  const entry = timings[label] ||= { count: 0, total: 0, samples: [], metadata: [], average: 0, p95: 0, max: 0 };
  entry.metadata ||= [];
  entry.count += 1;
  entry.total += elapsed;
  entry.samples.push(elapsed);
  entry.metadata.push(sampleMetadata(metadata));
  if (entry.samples.length > ROLLING_SAMPLE_COUNT) entry.samples.shift();
  if (entry.metadata.length > ROLLING_SAMPLE_COUNT) entry.metadata.shift();
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
