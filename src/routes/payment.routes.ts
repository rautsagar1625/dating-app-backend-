import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin, requirePermission } from '../middleware/admin.middleware';
import {
  createIntent,
  getPaymentHistory,
  requestRefund,
  listProducts,
  stripeWebhook,
  razorpayWebhook,
  appleWebhook,
  googleWebhook,
} from '../controllers/payment.controller';

const router = Router();

// ── Webhook routes — raw body required (registered before JSON middleware) ────
// These must be set up with express.raw() in server.ts, not express.json()
router.post('/webhooks/stripe',   stripeWebhook);
router.post('/webhooks/razorpay', razorpayWebhook);
router.post('/webhooks/apple',    appleWebhook);
router.post('/webhooks/google',   googleWebhook);

// ── Public routes ─────────────────────────────────────────────────────────────
router.get('/products', listProducts);

// ── Authenticated user routes ─────────────────────────────────────────────────
router.use(requireAuth);

router.post('/intent',                           createIntent);
router.get('/history',                           getPaymentHistory);
router.post('/:sessionId/refund',                requireAdmin, requirePermission('write:users'), requestRefund);

export default router;
