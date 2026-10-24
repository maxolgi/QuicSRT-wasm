// Shared time-window helper for the debug overlay. Every time-based chart
// slices its data through `windowed()` to the last WINDOW_SEC seconds.

import type { TimeSeriesBucket } from './types'

// Rolling window shown by every time-based chart (formerly adjustable via
// the removed 10/20/30s control; now fixed).
export const WINDOW_SEC = 30

export function windowed(
  history: TimeSeriesBucket[],
  windowSec: number = WINDOW_SEC,
): TimeSeriesBucket[] {
  if (windowSec <= 0 || history.length === 0) return history
  const refT = history[history.length - 1].t
  const cutoff = refT - windowSec * 1000
  return history.filter((b) => b.t >= cutoff)
}
