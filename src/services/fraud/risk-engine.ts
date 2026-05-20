import prisma from '../prisma.service';
import { flagsRedis } from '../flags/flag.cache';
import { logger } from '../../observability/logger';
import {
  SIGNAL_SCORES,
  EMULATOR_MODEL_PATTERNS,
  EMULATOR_BRAND_PATTERNS,
  scoreToLevel,
  ENFORCEMENT_THRESHOLDS,
  ClientFingerprint,
  FraudSignalType,
  hashIp,
  hashDeviceId,
} from './fraud.types';

const DEVICE_ACCOUNTS_WINDOW_S = 86400;   // 24h for rapid-registration check
const MULTI_ACCOUNT_THRESHOLD   = 1;       // >1 account per device = signal

// ── Signal emission ───────────────────────────────────────────────────────────

interface SignalPayload {
  type: FraudSignalType;
  userId?: string;
  deviceFpId?: string;
  metadata?: Record<string, unknown>;
}

async function emitSignal(payload: SignalPayload): Promise<void> {
  const score = SIGNAL_SCORES[payload.type];
  const severity =
    score >= 30 ? 'CRITICAL' :
    score >= 20 ? 'HIGH' :
    score >= 10 ? 'MEDIUM' : 'LOW';

  await prisma.fraudSignal.create({
    data: {
      signalType: payload.type,
      severity,
      score,
      userId:    payload.userId,
      deviceFpId: payload.deviceFpId,
      metadata:  (payload.metadata ?? {}) as object,
    },
  });
}

// ── Emulator detection ────────────────────────────────────────────────────────

export function detectEmulator(fp: ClientFingerprint): boolean {
  if (!fp.isDevice) return true;
  const model = fp.model ?? '';
  const brand = fp.brand ?? '';
  if (EMULATOR_MODEL_PATTERNS.some((r) => r.test(model))) return true;
  if (EMULATOR_BRAND_PATTERNS.some((r) => r.test(brand))) return true;
  return false;
}

// ── IP reputation (stub — wire in MaxMind GeoLite2 or ipinfo.io) ─────────────

const KNOWN_BAD_IP_HASHES = new Set<string>(); // populate from threat intel feed

async function checkIpReputation(ip: string): Promise<{ isDatacenter: boolean; isBadActor: boolean }> {
  const ipHash = hashIp(ip);

  // Plug in: MaxMind GeoLite2 ASN DB → check if ASN belongs to a hosting provider
  // const asn = await maxmind.get(ip);
  // const isDatacenter = DATACENTER_ASN_SET.has(asn?.autonomous_system_number);

  const isBadActor = KNOWN_BAD_IP_HASHES.has(ipHash);

  // Heuristic datacenter detection: common datacenter IPv4 ranges
  // For production: replace with maxmind.openAsn(ip).type === 'hosting'
  const datacenterPatterns = [
    /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/, // private ranges = likely proxy/VPN exit
    /^(45\.33\.|104\.18\.|172\.67\.)/, // common CDN/hosting blocks
  ];
  const isDatacenter = datacenterPatterns.some((p) => p.test(ip));

  return { isDatacenter, isBadActor };
}

// ── Multi-account detection ───────────────────────────────────────────────────

async function checkMultiAccount(
  deviceFpId: string,
  deviceIdHash: string,
  userId: string,
  rawIp: string,
): Promise<number> {
  let additionalScore = 0;

  // Check how many accounts are linked to this device
  const fp = await prisma.deviceFingerprint.findUnique({
    where: { id: deviceFpId },
    select: { linkedUserIds: true, recentIpHashes: true },
  });

  if (!fp) return 0;

  const accountsOnDevice = fp.linkedUserIds.filter((id) => id !== userId);

  if (accountsOnDevice.length > MULTI_ACCOUNT_THRESHOLD) {
    const extraAccounts = accountsOnDevice.length - MULTI_ACCOUNT_THRESHOLD;
    additionalScore += SIGNAL_SCORES.MULTI_ACCOUNT_DEVICE * Math.min(extraAccounts, 3);
    await emitSignal({
      type: 'MULTI_ACCOUNT_DEVICE',
      userId,
      deviceFpId,
      metadata: { accountCount: fp.linkedUserIds.length, accountIds: accountsOnDevice.slice(0, 5) },
    });
  }

  // Check rapid registration (multiple accounts from device in 24h via Redis)
  const regKey = `velvet:fraud:device-regs:${deviceIdHash}`;
  const regsInWindow = await flagsRedis.incr(regKey);
  if (regsInWindow === 1) await flagsRedis.expire(regKey, DEVICE_ACCOUNTS_WINDOW_S);

  if (regsInWindow > 1) {
    additionalScore += SIGNAL_SCORES.RAPID_REGISTRATION;
    await emitSignal({
      type: 'RAPID_REGISTRATION',
      userId,
      deviceFpId,
      metadata: { regsInLast24h: regsInWindow },
    });
  }

  // Multi-account on same IP (lighter signal — shared IPs are common)
  const ipHash = hashIp(rawIp);
  const ipKey = `velvet:fraud:ip-accounts:${ipHash}`;
  const ipAccountsRaw = await flagsRedis.smembers(ipKey);
  const ipAccounts = ipAccountsRaw.filter((id) => id !== userId);

  if (ipAccounts.length > 2) {
    additionalScore += SIGNAL_SCORES.MULTI_ACCOUNT_IP * Math.min(ipAccounts.length - 2, 4);
    await emitSignal({
      type: 'MULTI_ACCOUNT_IP',
      userId,
      deviceFpId,
      metadata: { accountsOnIp: ipAccounts.length, ipHash },
    });
  }

  // Track this userId → IP mapping (expires 7 days)
  await flagsRedis.sadd(ipKey, userId);
  await flagsRedis.expire(ipKey, 7 * 86400);

  return additionalScore;
}

// ── Core evaluation ───────────────────────────────────────────────────────────

export interface EvaluationResult {
  riskScore: number;
  riskLevel: ReturnType<typeof scoreToLevel>;
  deviceFpId: string;
  signals: string[];
  enforcement: string | null;
}

export async function evaluateDevice(
  userId: string,
  fp: ClientFingerprint,
  rawIp: string,
): Promise<EvaluationResult> {
  const deviceIdHash = hashDeviceId(fp.deviceId);
  const ipHash = hashIp(rawIp);
  let score = 0;
  const signals: string[] = [];

  // ── Step 1: Upsert device fingerprint record ──────────────────────────────

  const isEmulator = detectEmulator(fp);
  const isRooted   = fp.isRooted ?? false;

  // Add userId to linkedUserIds if not present
  const existing = await prisma.deviceFingerprint.findUnique({
    where: { deviceIdHash },
    select: { id: true, linkedUserIds: true, recentIpHashes: true, riskScore: true },
  });

  const linkedUserIds = existing
    ? Array.from(new Set([...existing.linkedUserIds, userId]))
    : [userId];

  const recentIpHashes = existing
    ? Array.from(new Set([...existing.recentIpHashes.slice(-4), ipHash]))
    : [ipHash];

  const device = await prisma.deviceFingerprint.upsert({
    where: { deviceIdHash },
    create: {
      deviceIdHash,
      brand:     fp.brand,
      model:     fp.model,
      osName:    fp.osName,
      osVersion: fp.osVersion,
      isEmulator,
      isRooted,
      linkedUserIds,
      recentIpHashes,
      firstSeenAt: new Date(),
      lastSeenAt:  new Date(),
    },
    update: {
      linkedUserIds,
      recentIpHashes,
      lastSeenAt: new Date(),
      seenCount:  { increment: 1 },
      // update hardware fields in case they changed (OS upgrade)
      osVersion: fp.osVersion,
    },
  });

  // ── Step 2: Apply signal weights ──────────────────────────────────────────

  if (isEmulator) {
    score += SIGNAL_SCORES.EMULATOR_DETECTED;
    signals.push('EMULATOR_DETECTED');
    await emitSignal({ type: 'EMULATOR_DETECTED', userId, deviceFpId: device.id, metadata: { brand: fp.brand, model: fp.model } });
  } else {
    // Check model even on "real" devices — some obfuscated emulators pass isDevice=true
    const model = fp.model ?? '';
    const brand = fp.brand ?? '';
    if (EMULATOR_MODEL_PATTERNS.some((r) => r.test(model)) || EMULATOR_BRAND_PATTERNS.some((r) => r.test(brand))) {
      score += SIGNAL_SCORES.SUSPICIOUS_MODEL;
      signals.push('SUSPICIOUS_MODEL');
      await emitSignal({ type: 'SUSPICIOUS_MODEL', userId, deviceFpId: device.id, metadata: { brand, model } });
    }
  }

  if (isRooted) {
    score += SIGNAL_SCORES.ROOT_JAILBREAK;
    signals.push('ROOT_JAILBREAK');
    await emitSignal({ type: 'ROOT_JAILBREAK', userId, deviceFpId: device.id });
  }

  // ── Step 3: IP reputation ─────────────────────────────────────────────────

  const ipRep = await checkIpReputation(rawIp);
  if (ipRep.isBadActor) {
    score += SIGNAL_SCORES.IP_REPUTATION_BAD;
    signals.push('IP_REPUTATION_BAD');
    await emitSignal({ type: 'IP_REPUTATION_BAD', userId, deviceFpId: device.id, metadata: { ipHash } });
  } else if (ipRep.isDatacenter) {
    score += SIGNAL_SCORES.VPN_DATACENTER;
    signals.push('VPN_DATACENTER');
    await emitSignal({ type: 'VPN_DATACENTER', userId, deviceFpId: device.id, metadata: { ipHash } });
  }

  // ── Step 4: Multi-account detection ──────────────────────────────────────

  const multiScore = await checkMultiAccount(device.id, deviceIdHash, userId, rawIp);
  score += multiScore;

  // ── Step 5: Cap and persist ───────────────────────────────────────────────

  score = Math.min(score, 100);
  const riskLevel = scoreToLevel(score);

  await prisma.deviceFingerprint.update({
    where: { id: device.id },
    data: { riskScore: score, riskLevel },
  });

  // Determine automated enforcement
  let enforcement: string | null = null;
  if (score >= ENFORCEMENT_THRESHOLDS.HARD_BAN)        enforcement = 'HARD_BAN';
  else if (score >= ENFORCEMENT_THRESHOLDS.SOFT_BAN)   enforcement = 'SOFT_BAN';
  else if (score >= ENFORCEMENT_THRESHOLDS.SHADOW_RESTRICT) enforcement = 'SHADOW_RESTRICT';
  else if (score >= ENFORCEMENT_THRESHOLDS.COOLDOWN)   enforcement = 'COOLDOWN';
  else if (score >= ENFORCEMENT_THRESHOLDS.WARN)        enforcement = 'WARN';

  logger.info(
    { userId, deviceFpId: device.id, riskScore: score, riskLevel, signals },
    'device risk evaluation complete',
  );

  return { riskScore: score, riskLevel, deviceFpId: device.id, signals, enforcement };
}
