ALTER TABLE "spfn_auth"."user_public_keys" ADD COLUMN "last_seen_ip" text;--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_public_keys" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_public_keys" ADD COLUMN "concurrent_use_at" timestamp with time zone;