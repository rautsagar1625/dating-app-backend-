import prisma from './prisma.service';

// Returns all user IDs that have a block relation (in either direction) with userId.
// Used to enforce mutual invisibility across browse, chat, and profile endpoints.
export const getBlockedUserIds = async (userId: string): Promise<string[]> => {
  const [made, received] = await Promise.all([
    prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true } }),
    prisma.block.findMany({ where: { blockedId: userId }, select: { blockerId: true } }),
  ]);
  const ids = new Set<string>();
  made.forEach((b) => ids.add(b.blockedId));
  received.forEach((b) => ids.add(b.blockerId));
  return [...ids];
};

// Returns true if a block exists in either direction between the two users.
export const isBlocked = async (userA: string, userB: string): Promise<boolean> => {
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userA, blockedId: userB },
        { blockerId: userB, blockedId: userA },
      ],
    },
    select: { id: true },
  });
  return !!block;
};
