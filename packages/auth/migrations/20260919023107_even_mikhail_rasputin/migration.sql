CREATE TABLE "spfn_auth"."mfa_challenges" (
	"id" bigserial PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"challenge_hash" text NOT NULL,
	"key_id" text NOT NULL,
	"channel" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"login_event" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_public_keys" ADD COLUMN "pending_mfa_challenge_id" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_challenge_hash_idx" ON "spfn_auth"."mfa_challenges" ("challenge_hash");--> statement-breakpoint
CREATE INDEX "mfa_challenges_expires_at_idx" ON "spfn_auth"."mfa_challenges" ("expires_at");--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_challenges" ADD CONSTRAINT "mfa_challenges_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "spfn_auth"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_challenges" ADD CONSTRAINT "mfa_challenges_key_id_user_public_keys_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "spfn_auth"."user_public_keys"("key_id") ON DELETE CASCADE;