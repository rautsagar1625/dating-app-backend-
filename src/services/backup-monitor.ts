import { Gauge, Counter } from 'prom-client';
import { flagsRedis } from './flags/flag.cache';
import { registry } from '../observability/metrics';
import { logger } from '../observability/logger';

// ── Prometheus metrics for backup staleness ───────────────────────────────────

const backupAgeGauge = new Gauge({
  name: 'velvet_backup_age_seconds',
  help: 'Seconds since the last successful backup of each type',
  labelNames: ['type'],
  registers: [registry],
});

const backupStatusGauge = new Gauge({
  name: 'velvet_backup_last_status',
  help: '1 = OK, 0 = FAILED or unknown, for most recent backup of each type',
  labelNames: ['type'],
  registers: [registry],
});

const backupSizeGauge = new Gauge({
  name: 'velvet_backup_size_bytes',
  help: 'Size in bytes of the most recent backup of each type',
  labelNames: ['type'],
  registers: [registry],
});

const backupVerifyGauge = new Gauge({
  name: 'velvet_backup_verify_ok',
  help: '1 if the most recent backup verification passed, 0 if failed or stale',
  registers: [registry],
});

export const backupRestoreTestAgeGauge = new Gauge({
  name: 'velvet_backup_restore_test_age_seconds',
  help: 'Seconds since the last automated restore test',
  registers: [registry],
});

// Alert counter — incremented when a stale backup is detected during scrape
const backupStalenessAlertTotal = new Counter({
  name: 'velvet_backup_staleness_alerts_total',
  help: 'Total times a backup was detected as stale during a metrics scrape',
  labelNames: ['type'],
  registers: [registry],
});

// ── Staleness thresholds ──────────────────────────────────────────────────────

const STALE_THRESHOLDS: Record<string, number> = {
  'pg-logical':    26 * 3600,   // alert if older than 26h
  'pg-walg':       26 * 3600,
  'redis':         14 * 3600,   // alert if older than 14h (runs twice daily)
  'media':         7  * 3600,   // alert if older than 7h (runs every 6h)
  'restore-test':  8  * 86400,  // alert if older than 8 days (runs weekly)
};

const BACKUP_TYPES = Object.keys(STALE_THRESHOLDS);

// ── Status interface ──────────────────────────────────────────────────────────

export interface BackupTypeStatus {
  type: string;
  status: 'OK' | 'FAILED' | 'STALE' | 'UNKNOWN';
  lastSuccessAt: string | null;
  ageSeconds: number | null;
  sizeBytes: number | null;
  lastError: string | null;
}

export interface BackupHealthSummary {
  healthy: boolean;
  verifyStatus: 'OK' | 'FAILED' | 'UNKNOWN';
  restoreTestAgeSeconds: number | null;
  types: BackupTypeStatus[];
  checkedAt: string;
}

// ── Core status reader ────────────────────────────────────────────────────────

export async function getBackupStatus(): Promise<BackupHealthSummary> {
  const now = Math.floor(Date.now() / 1000);
  const types: BackupTypeStatus[] = [];
  let allHealthy = true;

  for (const type of BACKUP_TYPES) {
    try {
      const [lastStatus, lastTsRaw, lastSuccessJson, lastError] = await Promise.all([
        flagsRedis.get(`velvet:backup:${type}:last_status`),
        flagsRedis.get(`velvet:backup:${type}:last_ts`),
        flagsRedis.get(`velvet:backup:${type}:last_success`),
        flagsRedis.get(`velvet:backup:${type}:last_error`),
      ]);

      const lastTs = lastTsRaw ? parseInt(lastTsRaw, 10) : null;
      const ageSeconds = lastTs ? now - lastTs : null;
      const threshold = STALE_THRESHOLDS[type];

      let parsedSize: number | null = null;
      if (lastSuccessJson) {
        try {
          const parsed = JSON.parse(lastSuccessJson);
          parsedSize = parsed.size ?? null;
        } catch { /* ignore */ }
      }

      let status: BackupTypeStatus['status'];
      if (lastStatus === 'FAILED') {
        status = 'FAILED';
        allHealthy = false;
      } else if (ageSeconds === null || ageSeconds > threshold) {
        status = ageSeconds === null ? 'UNKNOWN' : 'STALE';
        allHealthy = false;
      } else {
        status = 'OK';
      }

      types.push({
        type,
        status,
        lastSuccessAt: lastTs ? new Date(lastTs * 1000).toISOString() : null,
        ageSeconds,
        sizeBytes: parsedSize,
        lastError: lastError ?? null,
      });
    } catch (err) {
      logger.warn({ type, err }, 'backup-monitor: failed to read status from Redis');
      types.push({ type, status: 'UNKNOWN', lastSuccessAt: null, ageSeconds: null, sizeBytes: null, lastError: null });
    }
  }

  // Verify status
  let verifyStatus: 'OK' | 'FAILED' | 'UNKNOWN' = 'UNKNOWN';
  try {
    const v = await flagsRedis.get('velvet:backup:verify:last_status');
    verifyStatus = v === 'OK' ? 'OK' : v === 'FAILED' ? 'FAILED' : 'UNKNOWN';
    if (verifyStatus !== 'OK') allHealthy = false;
  } catch { /* ignore */ }

  // Restore test age
  let restoreTestAgeSeconds: number | null = null;
  try {
    const ts = await flagsRedis.get('velvet:backup:restore-test:last_ts');
    restoreTestAgeSeconds = ts ? now - parseInt(ts, 10) : null;
  } catch { /* ignore */ }

  return {
    healthy: allHealthy,
    verifyStatus,
    restoreTestAgeSeconds,
    types,
    checkedAt: new Date().toISOString(),
  };
}

// ── Prometheus metric updater ─────────────────────────────────────────────────
// Called once per scrape interval to push fresh values into Prometheus gauges.

export async function updateBackupMetrics(): Promise<void> {
  try {
    const summary = await getBackupStatus();
    const now = Math.floor(Date.now() / 1000);

    for (const t of summary.types) {
      backupAgeGauge.set({ type: t.type }, t.ageSeconds ?? 999999);
      backupStatusGauge.set({ type: t.type }, t.status === 'OK' ? 1 : 0);
      if (t.sizeBytes !== null) backupSizeGauge.set({ type: t.type }, t.sizeBytes);
      if (t.status === 'STALE' || t.status === 'UNKNOWN') {
        backupStalenessAlertTotal.inc({ type: t.type });
      }
    }

    backupVerifyGauge.set(summary.verifyStatus === 'OK' ? 1 : 0);

    if (summary.restoreTestAgeSeconds !== null) {
      backupRestoreTestAgeGauge.set(summary.restoreTestAgeSeconds);
    }
  } catch (err) {
    logger.warn({ err }, 'backup-monitor: metric update failed');
  }
}

// Refresh metrics every 5 minutes (between Prometheus scrapes)
const METRICS_INTERVAL_MS = 5 * 60 * 1000;
setInterval(updateBackupMetrics, METRICS_INTERVAL_MS);
// Initial population
updateBackupMetrics().catch(() => {});
