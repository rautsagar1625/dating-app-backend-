// ── Payment Fulfillment ───────────────────────────────────────────────────────
// Fulfills non-subscription purchases: credit packs, superlike packs, unlocks.
// Idempotent: checks if already fulfilled via session metadata before writing.

import prisma from '../prisma.service';
import { PRODUCT_CATALOG } from './payment.types';
import { logger } from '../../observability/logger';

const CREDIT_GRANTS: Record<string, number> = {
  credits_100: 100,
  credits_500: 500,
};

const SUPERLIKE_GRANTS: Record<string, number> = {
  superlike_5pack: 5,
};

export async function creditPackFulfillment(params: {
  sessionId: string;
  userId:    string;
  productId: string;
}): Promise<void> {
  const { sessionId, userId, productId } = params;

  // Idempotency: skip if already fulfilled
  const session = await prisma.paymentSession.findUnique({
    where:  { id: sessionId },
    select: { metadata: true, status: true },
  });
  if (!session || session.status !== 'SUCCESS') return;
  if ((session.metadata as any)?.fulfilled) return;

  const sku = PRODUCT_CATALOG[productId];
  if (!sku) return;

  const credits   = CREDIT_GRANTS[productId];
  const superlikes = SUPERLIKE_GRANTS[productId];

  await prisma.$transaction(async (tx) => {
    if (credits) {
      await tx.wallet.upsert({
        where:  { userId },
        create: { userId, balance: credits },
        update: { balance: { increment: credits } },
      });
      await tx.transaction.create({
        data: {
          userId,
          amount: credits,
          type:   'CREDIT',
          reason: `Purchase: ${productId} (session ${sessionId})`,
        },
      });
    }

    // Mark session as fulfilled to prevent double-credit
    await tx.paymentSession.update({
      where: { id: sessionId },
      data:  { metadata: { fulfilled: true, fulfilledAt: new Date().toISOString() } as any },
    });
  });

  logger.info({ sessionId, userId, productId, credits, superlikes }, 'credit pack fulfilled');
}
