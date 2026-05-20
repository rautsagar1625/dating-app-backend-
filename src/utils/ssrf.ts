import dns from 'dns/promises';

// ── Private IP detection ──────────────────────────────────────────────────────
// Covers RFC 1918, loopback, link-local, AWS metadata, CGN, IPv6 private

const PRIVATE_RANGES_V4: Array<[number, number]> = [
  [ipToInt('10.0.0.0'),      ipToInt('10.255.255.255')],
  [ipToInt('172.16.0.0'),    ipToInt('172.31.255.255')],
  [ipToInt('192.168.0.0'),   ipToInt('192.168.255.255')],
  [ipToInt('127.0.0.0'),     ipToInt('127.255.255.255')],
  [ipToInt('169.254.0.0'),   ipToInt('169.254.255.255')],  // link-local + AWS metadata
  [ipToInt('100.64.0.0'),    ipToInt('100.127.255.255')],  // CGN (RFC 6598)
  [ipToInt('0.0.0.0'),       ipToInt('0.255.255.255')],
];

const BLOCKED_HOSTNAMES = new Set([
  '169.254.169.254',         // AWS/GCP/Azure IMDS
  'metadata.google.internal',
  'metadata.aws.internal',
  'metadata.azure.internal',
  'fd00::ec2:254',           // AWS metadata IPv6
  'localhost',
  '::1',
  '::ffff:127.0.0.1',
]);

const PRIVATE_IPV6_PREFIXES = [
  'fc', 'fd',               // Unique local
  'fe80',                   // Link-local
  '::1',                    // Loopback
];

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

export function isPrivateIp(host: string): boolean {
  if (BLOCKED_HOSTNAMES.has(host.toLowerCase())) return true;

  // IPv4 check
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const n = ipToInt(host);
    return PRIVATE_RANGES_V4.some(([lo, hi]) => n >= lo && n <= hi);
  }

  // IPv6 check
  const v6 = host.toLowerCase().replace(/^\[|\]$/g, '');
  return PRIVATE_IPV6_PREFIXES.some((prefix) => v6.startsWith(prefix));
}

// ── URL validation with DNS resolution ───────────────────────────────────────

export async function validateExternalUrl(
  rawUrl: string,
): Promise<{ valid: boolean; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'invalid_url' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, reason: 'protocol_not_allowed' };
  }

  const hostname = parsed.hostname;

  // Fast check before DNS
  if (isPrivateIp(hostname)) {
    return { valid: false, reason: 'ssrf_private_host' };
  }

  // DNS resolution check — prevents rebinding attacks
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    for (const { address } of addresses) {
      if (isPrivateIp(address)) {
        return { valid: false, reason: 'ssrf_resolved_private_ip' };
      }
    }
  } catch {
    return { valid: false, reason: 'dns_resolution_failed' };
  }

  return { valid: true };
}

// ── Middleware: block SSRF targets in request body/query ──────────────────────

function collectStrings(obj: unknown, acc: string[] = [], depth = 0): string[] {
  if (depth > 5 || !obj) return acc;
  if (typeof obj === 'string') { acc.push(obj); return acc; }
  if (typeof obj === 'object') {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      collectStrings(v, acc, depth + 1);
    }
  }
  return acc;
}

import { Request, Response, NextFunction } from 'express';

export function blockSsrfTargets(req: Request, res: Response, next: NextFunction): void {
  const candidates = collectStrings([req.body, req.query])
    .filter((s) => s.startsWith('http://') || s.startsWith('https://'));

  for (const candidate of candidates) {
    try {
      const { hostname } = new URL(candidate);
      if (isPrivateIp(hostname)) {
        res.status(400).json({ success: false, message: 'Invalid request' });
        return;
      }
    } catch { /* ignore non-URL strings */ }
  }
  next();
}
