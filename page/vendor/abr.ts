// ABR decision engine for the player's quality ladder: converts ~1 Hz
// cumulative StatsMsg counter deltas into one rung decision per tick.
// BAD = dropDelta > 0 or lossPct > 10, sustained 5 s -> 'down';
// GOOD = dropDelta == 0 and lossPct < 1, sustained 60 s -> 'up';
// the middle zone (and a > 5 s tick gap) clears both streaks.
// lossPct = lossDelta / (dataDelta + lossDelta) * 100, deltas taken
// against the previous tick's cumulative counters (rxData/rxLoss/
// rxDropped are since-connect totals; see js/srt_engine.js getStats).

export interface AbrStatsSample {
  rxData: number;
  rxLoss: number;
  rxDropped: number;
}

export type AbrDecision = 'down' | 'up' | null;

export interface AbrThresholds {
  badLossPct: number;
  goodLossPct: number;
  badMs: number;
  goodMs: number;
  tickGapResetMs: number;
}

export const DEFAULT_ABR_THRESHOLDS: AbrThresholds = {
  badLossPct: 10,
  goodLossPct: 1,
  badMs: 5000,
  goodMs: 60000,
  tickGapResetMs: 5000,
};

export interface AbrEngine {
  tick(sample: AbrStatsSample, nowMs: number): AbrDecision;
  reset(): void;
}

export function createAbr(thresholds?: Partial<AbrThresholds>): AbrEngine {
  const t: AbrThresholds = { ...DEFAULT_ABR_THRESHOLDS, ...thresholds };
  let baseline: AbrStatsSample | null = null;
  let lastTickMs = 0;
  // Streak anchors: the lastTickMs of the tick BEFORE the streak's first
  // tick (the last moment the link was not in that state), so a streak's
  // age spans back across its first tick. Null = no active streak.
  let badSince: number | null = null;
  let goodSince: number | null = null;

  function reset(): void {
    baseline = null;
    badSince = null;
    goodSince = null;
  }

  function tick(sample: AbrStatsSample, nowMs: number): AbrDecision {
    // First tick after create/reset: record the baseline, judge nothing.
    if (baseline === null) {
      baseline = sample;
      lastTickMs = nowMs;
      return null;
    }
    // A reconnect pause (the worker is torn down during rung switches):
    // void the streaks AND the baseline, then re-baseline on this tick.
    if (nowMs - lastTickMs > t.tickGapResetMs) {
      reset();
      baseline = sample;
      lastTickMs = nowMs;
      return null;
    }
    const dataDelta = sample.rxData - baseline.rxData;
    const lossDelta = sample.rxLoss - baseline.rxLoss;
    const dropDelta = sample.rxDropped - baseline.rxDropped;
    const prevTickMs = lastTickMs;
    lastTickMs = nowMs;
    if (dataDelta <= 0) return null; // no traffic to judge; baseline + streaks carry over
    baseline = sample;
    const lossPct = (lossDelta / (dataDelta + lossDelta)) * 100;
    if (dropDelta > 0 || lossPct > t.badLossPct) {
      goodSince = null;
      if (badSince === null) badSince = prevTickMs;
      if (nowMs - badSince >= t.badMs) {
        reset();
        baseline = sample; // re-anchor on the decision tick: the next tick is judged fresh
        lastTickMs = nowMs;
        return 'down';
      }
      return null;
    }
    if (dropDelta === 0 && lossPct < t.goodLossPct) {
      badSince = null;
      if (goodSince === null) goodSince = prevTickMs;
      if (nowMs - goodSince >= t.goodMs) {
        reset();
        baseline = sample; // re-anchor on the decision tick: the next tick is judged fresh
        lastTickMs = nowMs;
        return 'up';
      }
      return null;
    }
    // Middle zone (goodLossPct <= lossPct <= badLossPct, no drops):
    // hysteresis - neither streak may claim it.
    badSince = null;
    goodSince = null;
    return null;
  }

  return { tick, reset };
}
