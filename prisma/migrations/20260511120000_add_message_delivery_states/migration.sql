-- Add message delivery state fields and idempotency key
ALTER TABLE "Message" ADD COLUMN "clientTempId" TEXT;
ALTER TABLE "Message" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'SENT';
ALTER TABLE "Message" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "seenAt" TIMESTAMP(3);

-- Add VarChar constraint (change column type)
ALTER TABLE "Message" ALTER COLUMN "message" TYPE VARCHAR(1000);

-- Idempotency: unique constraint on clientTempId (nullable, so only non-null values are unique)
CREATE UNIQUE INDEX "Message_clientTempId_key" ON "Message"("clientTempId");

-- Index for delivery status queries
CREATE INDEX "Message_chatId_status_idx" ON "Message"("chatId", "status");
