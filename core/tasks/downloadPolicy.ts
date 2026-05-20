import type { DownloadPolicy, RiskPaceLevel } from './types.js';

export const RISK_PACE_PRESETS: Record<RiskPaceLevel, DownloadPolicy> = {
  fast: {
    safeMode: true,
    riskPaceLevel: 'fast',
    imageConcurrency: 2,
    requestDelayMs: 800,
    taskCooldownMin: 30,
    taskCooldownMax: 75,
    browsePauseMin: 180,
    browsePauseMax: 360,
    browseInterval: 12,
    enablePrewarm: false,
  },
  standard: {
    safeMode: true,
    riskPaceLevel: 'standard',
    imageConcurrency: 2,
    requestDelayMs: 800,
    taskCooldownMin: 60,
    taskCooldownMax: 150,
    browsePauseMin: 300,
    browsePauseMax: 600,
    browseInterval: 10,
    enablePrewarm: false,
  },
  conservative: {
    safeMode: true,
    riskPaceLevel: 'conservative',
    imageConcurrency: 1,
    requestDelayMs: 1200,
    taskCooldownMin: 120,
    taskCooldownMax: 300,
    browsePauseMin: 600,
    browsePauseMax: 1200,
    browseInterval: 6,
    enablePrewarm: false,
  },
};

export const DEFAULT_RISK_PACE_LEVEL: RiskPaceLevel = 'standard';

export const DEFAULT_DOWNLOAD_POLICY: DownloadPolicy = RISK_PACE_PRESETS[DEFAULT_RISK_PACE_LEVEL];
