ALTER TABLE "spfn_notification"."history" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "spfn_notification"."history" ADD COLUMN "claim_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "noti_idempotency_idx" ON "spfn_notification"."history" ("channel","idempotency_key","recipient") WHERE "idempotency_key" is not null;