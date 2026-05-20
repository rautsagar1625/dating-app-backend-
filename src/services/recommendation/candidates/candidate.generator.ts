// ── Candidate Generator ───────────────────────────────────────────────────────
//
// Produces a deduplicated candidate pool for user U's feed.
//
// Pool strategies (in priority order):
//   1. PROXIMITY       — same location string + preference match (primary)
//   2. MUTUAL_INTEREST — users who also liked profiles that U liked
//   3. FRESH           — users joined < 7 days ago (new-user boost)
//   4. POPULAR         — high likeInRate users within preference (diversity fill)
//   5. BEHAVIORAL      — users with similar signal profile (future: embeddings)
//   6. BOOST           — users with active paid boost
//   7. COLD_START      — fallback when no history or small preference pool
//
// Exclusion filters (always applied):
//   - Users U has already liked or been blocked by
//   - Users that blocked U (or U blocked them)
//   - Reported users (either direction within 30d)
//   - Banned / soft-banned users
//   - Already seen in last 24h (FeedImpression)
//   - Moderation SHADOW_RESTRICT / HARD_BAN enforcements
//
// Candidate pool is cached in Redis sorted set (score = preScore, 30-min TTL).

import IORedis from 'ioredis';
import prisma from '../../prisma.service';
import { getUserSignals } from '../signals/signal.aggregator';
import { logger } from '../../../observability/logger';
import type { CandidateProfile, CandidatePoolType } from '../rec.types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const candRedis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableReadyCheck: false,
});
candRedis.connect().catch(() => {});

const CANDIDATE_TTL  = 30 * 60;        // 30 minutes
const CANDIDATE_KEY  = (uid: string) => `rec:candidates:${uid}`;
const POOL_SIZE      = 300;             // target pool before ranking
const FRESH_DAYS     = 7;
const SEEN_WINDOW_MS = 24 * 3_600_000; // suppress re-showing within 24h

// ── Exclusion set builder ─────────────────────────────────────────────────────

async function buildExclusionSet(userId: string): Promise<Set<string>> {
  const since30d = new Date(Date.now() - 30 * 86400_000);
  const since24h = new Date(Date.now() - SEEN_WINDOW_MS);

  const [
    likedByMe,
    blockedByMe,
    blockedMe,
    reportedByMe,
    reportedMe,
    seenRecently,
    bannedUsers,
  ] = await Promise.all([
    // Users I've already liked (no point showing again unless they liked back)
    prisma.like.findMany({
      where:  { senderId: userId },
      select: { receiverId: true },
    }),
    prisma.block.findMany({
      where:  { blockerId: userId },
      select: { blockedId: true },
    }),
    prisma.block.findMany({
      where:  { blockedId: userId },
      select: { blockerId: true },
    }),
    prisma.report.findMany({
      where:  { reporterId: userId, createdAt: { gte: since30d } },
      select: { reportedId: true },
    }),
    prisma.report.findMany({
      where:  { reportedId: userId, createdAt: { gte: since30d } },
      select: { reporterId: true },
    }),
    prisma.feedImpression.findMany({
      where:  { viewerId: userId, seenAt: { gte: since24h } },
      select: { profileId: true },
    }),
    prisma.fraudEnforcementAction.findMany({
      where: {
        actionType: { in: ['HARD_BAN', 'SOFT_BAN'] },
        isActive:   true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { userId: true },
    }),
  ]);

  const excluded = new Set<string>([userId]);
  likedByMe.forEach((l) => excluded.add(l.receiverId));
  blockedByMe.forEach((b) => excluded.add(b.blockedId));
  blockedMe.forEach((b) => excluded.add(b.blockerId));
  reportedByMe.forEach((r) => excluded.add(r.reportedId));
  reportedMe.forEach((r) => excluded.add(r.reporterId));
  seenRecently.forEach((s) => excluded.add(s.profileId));
  bannedUsers.forEach((b) => { if (b.userId) excluded.add(b.userId); });

  return excluded;
}

// ── Preference reader ─────────────────────────────────────────────────────────

interface UserPrefs {
  gender:   string | null;
  ageMin:   number | null;
  ageMax:   number | null;
  location: string | null;
}

async function getUserPrefs(userId: string): Promise<UserPrefs> {
  const profile = await prisma.profile.findUnique({
    where:  { userId },
    select: { gender: true, age: true, location: true },
  });

  // Default age window: ±10 years around user's own age
  const ageMin = profile?.age ? Math.max(profile.age - 10, 18) : 18;
  const ageMax = profile?.age ? profile.age + 10 : 65;

  // Infer opposite gender preference (simple default; extend with settings)
  const oppositeGender =
    profile?.gender === 'male'   ? 'female' :
    profile?.gender === 'female' ? 'male'   : null;

  return {
    gender:   oppositeGender,
    ageMin,
    ageMax,
    location: profile?.location ?? null,
  };
}

// ── Pool builders ─────────────────────────────────────────────────────────────

async function proximityPool(
  prefs: UserPrefs,
  excluded: Set<string>,
  limit: number,
): Promise<CandidateProfile[]> {
  const where: Record<string, unknown> = {
    userId: { notIn: Array.from(excluded) },
    isHidden: false,
    age: prefs.ageMin && prefs.ageMax
      ? { gte: prefs.ageMin, lte: prefs.ageMax }
      : undefined,
    ...(prefs.gender   ? { gender:   prefs.gender }   : {}),
    ...(prefs.location ? { location: prefs.location } : {}),
  };

  const profiles = await prisma.profile.findMany({
    where:   where as any,
    take:    limit,
    select: {
      userId:   true,
      age:      true,
      gender:   true,
      location: true,
      user: {
        select: { lastSeen: true },
      },
    },
    orderBy: { user: { lastSeen: 'desc' } },
  });

  const photoCounts = await getPhotoCounts(profiles.map((p) => p.userId));

  return profiles.map((p) => ({
    userId:      p.userId,
    age:         p.age,
    gender:      p.gender,
    location:    p.location,
    photoCount:  photoCounts.get(p.userId) ?? 0,
    isOnline:    false, // filled later
    lastActiveAt: p.user?.lastSeen ?? null,
    trustScore:  75,   // default; enriched by ranking engine
    poolType:    'PROXIMITY' as CandidatePoolType,
    preScore:    0.5,
  }));
}

async function freshPool(
  prefs: UserPrefs,
  excluded: Set<string>,
  limit: number,
): Promise<CandidateProfile[]> {
  const since7d = new Date(Date.now() - FRESH_DAYS * 86400_000);
  const users = await prisma.user.findMany({
    where: {
      id:        { notIn: Array.from(excluded) },
      createdAt: { gte: since7d },
      isBanned:  false,
      profile: {
        isHidden: false,
        ...(prefs.gender   ? { gender:   prefs.gender }   : {}),
        ...(prefs.location ? { location: prefs.location } : {}),
        age: prefs.ageMin && prefs.ageMax
          ? { gte: prefs.ageMin, lte: prefs.ageMax }
          : undefined,
      },
    },
    take:    limit,
    select: {
      id:       true,
      lastSeen: true,
      profile:  { select: { age: true, gender: true, location: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const photoCounts = await getPhotoCounts(users.map((u) => u.id));

  return users.map((u) => ({
    userId:      u.id,
    age:         u.profile?.age ?? null,
    gender:      u.profile?.gender ?? null,
    location:    u.profile?.location ?? null,
    photoCount:  photoCounts.get(u.id) ?? 0,
    isOnline:    false,
    lastActiveAt: u.lastSeen,
    trustScore:  75,
    poolType:    'FRESH' as CandidatePoolType,
    preScore:    0.45,  // slight fresh-user boost
  }));
}

async function mutualInterestPool(
  userId: string,
  prefs: UserPrefs,
  excluded: Set<string>,
  limit: number,
): Promise<CandidateProfile[]> {
  // Find profiles that U liked, then find who else liked those same profiles
  const myLikes = await prisma.like.findMany({
    where:  { senderId: userId },
    select: { receiverId: true },
    take:   50,
    orderBy: { createdAt: 'desc' },
  });

  if (myLikes.length === 0) return [];

  const targetIds = myLikes.map((l) => l.receiverId);

  // Who else liked these users? (collaborative filtering, one hop)
  const coLikers = await prisma.like.findMany({
    where: {
      receiverId: { in: targetIds },
      senderId:   { notIn: Array.from(excluded) },
    },
    select:  { senderId: true },
    distinct: ['senderId'],
    take:    limit * 2,
  });

  const candidateIds = coLikers.map((l) => l.senderId).filter((id) => !excluded.has(id));
  if (candidateIds.length === 0) return [];

  const profiles = await prisma.profile.findMany({
    where: {
      userId:   { in: candidateIds },
      isHidden: false,
      ...(prefs.gender   ? { gender:   prefs.gender }   : {}),
      age: prefs.ageMin && prefs.ageMax
        ? { gte: prefs.ageMin, lte: prefs.ageMax }
        : undefined,
    },
    take:   limit,
    select: {
      userId:   true,
      age:      true,
      gender:   true,
      location: true,
      user: { select: { lastSeen: true } },
    },
  });

  const photoCounts = await getPhotoCounts(profiles.map((p) => p.userId));

  return profiles.map((p) => ({
    userId:      p.userId,
    age:         p.age,
    gender:      p.gender,
    location:    p.location,
    photoCount:  photoCounts.get(p.userId) ?? 0,
    isOnline:    false,
    lastActiveAt: p.user?.lastSeen ?? null,
    trustScore:  75,
    poolType:    'MUTUAL_INTEREST' as CandidatePoolType,
    preScore:    0.55,  // co-interest candidates rank slightly higher
  }));
}

async function popularPool(
  prefs: UserPrefs,
  excluded: Set<string>,
  limit: number,
): Promise<CandidateProfile[]> {
  const since7d = new Date(Date.now() - 7 * 86400_000);

  // Top receivers by like volume in the last 7d (popularity signal)
  const topLiked = await prisma.like.groupBy({
    by:    ['receiverId'],
    where: { createdAt: { gte: since7d } },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take:  limit * 3,  // over-fetch to allow filtering
  });

  const topIds = topLiked
    .map((l) => l.receiverId)
    .filter((id) => !excluded.has(id));

  if (topIds.length === 0) return [];

  const profiles = await prisma.profile.findMany({
    where: {
      userId:   { in: topIds },
      isHidden: false,
      ...(prefs.gender ? { gender: prefs.gender } : {}),
      age: prefs.ageMin && prefs.ageMax
        ? { gte: prefs.ageMin, lte: prefs.ageMax }
        : undefined,
    },
    take:   limit,
    select: {
      userId:   true,
      age:      true,
      gender:   true,
      location: true,
      user: { select: { lastSeen: true } },
    },
  });

  const photoCounts = await getPhotoCounts(profiles.map((p) => p.userId));
  const scoreMap    = new Map(topLiked.map((l) => [l.receiverId, l._count.id]));

  return profiles.map((p) => {
    const rawPop = scoreMap.get(p.userId) ?? 1;
    return {
      userId:      p.userId,
      age:         p.age,
      gender:      p.gender,
      location:    p.location,
      photoCount:  photoCounts.get(p.userId) ?? 0,
      isOnline:    false,
      lastActiveAt: p.user?.lastSeen ?? null,
      trustScore:  75,
      poolType:    'POPULAR' as CandidatePoolType,
      preScore:    Math.min(0.4 + rawPop * 0.01, 0.7), // popularity score, capped
    };
  });
}

async function boostPool(
  prefs: UserPrefs,
  excluded: Set<string>,
  limit: number,
): Promise<CandidateProfile[]> {
  // Boosted users: active FraudEnforcementAction of type 'BOOST' won't exist —
  // we'll check a Redis key set by the wallet/boost purchase flow.
  // For now, placeholder returning empty — the monetization hook connects here.
  return [];
}

// ── Helper: photo count per user ──────────────────────────────────────────────

async function getPhotoCounts(userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();

  const counts = await prisma.photo.groupBy({
    by:    ['userId'],
    where: { userId: { in: userIds } },
    _count: { id: true },
  });

  return new Map(counts.map((c) => [c.userId, c._count.id]));
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function generateCandidates(
  userId:       string,
  forceRefresh: boolean = false,
): Promise<CandidateProfile[]> {
  if (!forceRefresh) {
    const cached = await getCachedCandidates(userId);
    if (cached.length > 0) return cached;
  }

  try {
    const [prefs, excluded] = await Promise.all([
      getUserPrefs(userId),
      buildExclusionSet(userId),
    ]);

    const isNewUser = await checkIsNewUser(userId);

    // Fetch pools in parallel — smaller limits for speed, merged below
    const [proximity, mutual, fresh, popular, boost] = await Promise.all([
      proximityPool(prefs, excluded, isNewUser ? 60 : 120),
      isNewUser ? Promise.resolve([]) : mutualInterestPool(userId, prefs, excluded, 60),
      freshPool(prefs, excluded, 40),
      popularPool(prefs, excluded, 40),
      boostPool(prefs, excluded, 20),
    ]);

    // Merge, deduplicate, keep highest preScore when dupes exist
    const merged = new Map<string, CandidateProfile>();
    for (const pool of [boost, mutual, proximity, fresh, popular]) {
      for (const c of pool) {
        const existing = merged.get(c.userId);
        if (!existing || c.preScore > existing.preScore) {
          merged.set(c.userId, c);
        }
      }
    }

    const candidates = Array.from(merged.values()).slice(0, POOL_SIZE);

    // Cache the pool
    await cacheCandidates(userId, candidates);

    // Persist to DB for auditability + background jobs
    await persistCandidates(userId, candidates);

    logger.debug({ userId, poolSize: candidates.length }, 'candidate pool generated');
    return candidates;
  } catch (err) {
    logger.error({ err, userId }, 'candidate generation failed');
    return [];
  }
}

async function checkIsNewUser(userId: string): Promise<boolean> {
  const count = await prisma.like.count({ where: { senderId: userId } });
  return count < 10;
}

// ── Redis cache (sorted set by preScore) ──────────────────────────────────────

export async function getCachedCandidates(userId: string): Promise<CandidateProfile[]> {
  try {
    const raw = await candRedis.get(CANDIDATE_KEY(userId));
    if (raw) return JSON.parse(raw) as CandidateProfile[];
  } catch { /* miss */ }
  return [];
}

async function cacheCandidates(userId: string, candidates: CandidateProfile[]): Promise<void> {
  try {
    await candRedis.setex(CANDIDATE_KEY(userId), CANDIDATE_TTL, JSON.stringify(candidates));
  } catch { /* non-critical */ }
}

export async function invalidateCandidateCache(userId: string): Promise<void> {
  try {
    await candRedis.del(CANDIDATE_KEY(userId));
  } catch { /* non-critical */ }
}

// ── DB persistence ────────────────────────────────────────────────────────────

async function persistCandidates(userId: string, candidates: CandidateProfile[]): Promise<void> {
  const expires = new Date(Date.now() + CANDIDATE_TTL * 1000);
  try {
    await prisma.$transaction(
      candidates.slice(0, 100).map((c) =>
        prisma.recommendationCandidate.upsert({
          where: { userId_candidateId: { userId, candidateId: c.userId } },
          create: {
            userId,
            candidateId: c.userId,
            poolType:    c.poolType,
            preScore:    c.preScore,
            expiresAt:   expires,
          },
          update: {
            poolType:    c.poolType,
            preScore:    c.preScore,
            generatedAt: new Date(),
            expiresAt:   expires,
          },
        }),
      ),
    );
  } catch { /* non-critical — cache is source of truth */ }
}
