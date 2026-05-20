import crypto from 'crypto';

// ── Signal types and their base risk scores ───────────────────────────────────

export const SIGNAL_SCORES = {
  EMULATOR_DETECTED:     40,  // near-certain abuse signal
  SUSPICIOUS_MODEL:      20,  // model name matches known emulator patterns
  ROOT_JAILBREAK:        15,  // compromised device — high abuse potential
  MULTI_ACCOUNT_DEVICE:  25,  // per extra account beyond first (additive)
  MULTI_ACCOUNT_IP:       8,  // per extra account on same IP (shared IPs exist)
  RAPID_REGISTRATION:    20,  // >1 account registered from device in 24h
  BEHAVIORAL_SPAM:       25,  // spam message pattern detected
  BEHAVIORAL_BOT:        30,  // inhuman timing or identical-action bursts
  VPN_DATACENTER:        10,  // datacenter/VPN IP (many legit users use VPNs)
  IP_REPUTATION_BAD:     25,  // IP on known abuse list
  DEVICE_ID_MISSING:     10,  // no X-Device-ID header — likely scraper/bot
  DEVICE_ID_CYCLING:     20,  // device ID rotated between requests (evasion)
  REPORT_VELOCITY:       15,  // received many user reports in short window
} as const;

export type FraudSignalType = keyof typeof SIGNAL_SCORES;

// ── Risk levels ────────────────────────────────────────────────────────────────

export const RISK_LEVELS = ['CLEAN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'EXTREME'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_THRESHOLDS: Record<RiskLevel, number> = {
  CLEAN:    0,
  LOW:      20,
  MEDIUM:   40,
  HIGH:     60,
  CRITICAL: 75,
  EXTREME:  90,
};

export function scoreToLevel(score: number): RiskLevel {
  if (score >= RISK_THRESHOLDS.EXTREME)   return 'EXTREME';
  if (score >= RISK_THRESHOLDS.CRITICAL)  return 'CRITICAL';
  if (score >= RISK_THRESHOLDS.HIGH)      return 'HIGH';
  if (score >= RISK_THRESHOLDS.MEDIUM)    return 'MEDIUM';
  if (score >= RISK_THRESHOLDS.LOW)       return 'LOW';
  return 'CLEAN';
}

// ── Enforcement types ─────────────────────────────────────────────────────────

export const ENFORCEMENT_TYPES = [
  'WARN',
  'COOLDOWN',
  'SHADOW_RESTRICT',
  'SOFT_BAN',
  'HARD_BAN',
] as const;

export type EnforcementType = (typeof ENFORCEMENT_TYPES)[number];

// Minimum risk level that triggers each enforcement tier (automated)
export const ENFORCEMENT_THRESHOLDS: Record<EnforcementType, number> = {
  WARN:             20,
  COOLDOWN:         40,
  SHADOW_RESTRICT:  60,
  SOFT_BAN:         75,
  HARD_BAN:         90,
};

// ── Device fingerprint payload sent from the client ───────────────────────────

export interface ClientFingerprint {
  deviceId: string       // UUID generated once on first install, persisted in AsyncStorage
  brand: string | null
  model: string | null
  osName: string | null
  osVersion: string | null
  isDevice: boolean      // false = running on simulator/emulator (expo-device)
  isRooted: boolean | null
  appVersion: string | null
  screenWidth: number
  screenHeight: number
  timezone: string
  locale: string
}

// Request context attached by device.middleware.ts
export interface DeviceContext {
  deviceId: string | null        // raw, from X-Device-ID header
  deviceIdHash: string | null    // SHA-256(deviceId + DEVICE_ID_SALT)
  ipHash: string                 // SHA-256(ip + IP_HASH_SALT)
  rawIp: string
  fingerprint: ClientFingerprint | null
}

// ── Known emulator/VM model patterns ─────────────────────────────────────────

export const EMULATOR_MODEL_PATTERNS = [
  /emulator/i, /android sdk/i, /sdk_gphone/i, /generic/i, /genymotion/i,
  /vbox/i, /virtual/i, /bluestacks/i, /nox/i, /memu/i, /ldplayer/i,
];

export const EMULATOR_BRAND_PATTERNS = [
  /generic/i, /unknown/i, /genymotion/i, /bluestacks/i,
];

// ── Privacy helpers ───────────────────────────────────────────────────────────

const DEVICE_ID_SALT = process.env.DEVICE_ID_SALT || 'velvet-device-salt-changeme';
const IP_HASH_SALT   = process.env.IP_HASH_SALT   || 'velvet-ip-salt-changeme';

export function hashDeviceId(deviceId: string): string {
  return crypto.createHmac('sha256', DEVICE_ID_SALT).update(deviceId).digest('hex');
}

export function hashIp(ip: string): string {
  return crypto.createHmac('sha256', IP_HASH_SALT).update(ip).digest('hex');
}
