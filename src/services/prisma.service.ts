import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { logger } from '../observability/logger';
import { dbQueryDuration, dbSlowQueryTotal } from '../observability/metrics';

const SLOW_QUERY_MS = 100;

const connectionString = process.env.DATABASE_URL!;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);

const basePrisma = new PrismaClient({ adapter });

// Instrument all Prisma queries: record duration, flag slow queries.
const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const start = Date.now();
        try {
          return await query(args);
        } finally {
          const durationSec = (Date.now() - start) / 1000;
          const labels = { operation, model: model ?? 'raw' };
          dbQueryDuration.observe(labels, durationSec);
          if (durationSec * 1000 > SLOW_QUERY_MS) {
            dbSlowQueryTotal.inc(labels);
            logger.warn({ operation, model, durationMs: Math.round(durationSec * 1000) }, 'slow db query');
          }
        }
      },
    },
  },
});

export default prisma;
