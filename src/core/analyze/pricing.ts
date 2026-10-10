import { int0 } from "./format";

export const CACHE_READ_RATE = 0.1;
export const CACHE_WRITE_RATE = 1.25;
export const OUTPUT_RATE = 5.0;

/** Rough price ratios against the flagship of each family. burn.py:44 */
export const MODEL_RATE: Record<string, number> = {
  haiku: 0.2,
  sonnet: 0.6,
  opus: 1.0,
  "gpt-5-mini": 0.2,
  "gpt-5.5": 1.0,
  "gpt-5": 1.0,
};

/** Longest key first, so "gpt-5-mini" does not match "gpt-5". burn.py:61 */
const RATES = Object.entries(MODEL_RATE).sort((a, b) => b[0].length - a[0].length);

export const SIZE_BUCKETS: [number, number | null][] = [
  [0, 100],
  [100, 200],
  [200, 300],
  [300, 500],
  [500, 1000],
  [1000, null],
];

/** Price ratio for a model id, or null when the model is unknown. burn.py:59 */
export function modelRate(model: string | null): number | null {
  const id = model || "";
  for (const [name, rate] of RATES) if (id.includes(name)) return rate;
  return null;
}

/** The context-size bucket a turn of `tokens` falls in. burn.py:67 */
export function bucketLabel(tokens: number): string {
  for (const [low, high] of SIZE_BUCKETS) {
    if (high === null || (low <= tokens / 1000 && tokens / 1000 < high)) {
      return high === null ? `${low}k+` : `${low}-${high}k`;
    }
  }
  return "?";
}

/** The bucket label for a bucket row, from its edges. burn.py:751 */
export function bucketRowLabel(low: number, high: number | null): string {
  return high === null ? `${low}k+` : `${low}-${high}k`;
}

/** Shared by flags and reports: "%dk" % (tokens / 1000). */
export function kilo(tokens: number): string {
  return int0(tokens / 1000);
}