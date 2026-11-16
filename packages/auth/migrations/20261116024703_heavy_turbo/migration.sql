CREATE TABLE "spfn_auth"."mfa_attempt_budgets" (
	"user_id" bigint PRIMARY KEY,
	"failed_at" timestamp with time zone[] NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spfn_auth"."passkeys" ADD COLUMN "registered_user_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_verifications" ADD COLUMN "id" bigserial;--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_verifications" ADD COLUMN "profile" text;--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_verifications" ADD COLUMN "profile_key_id" text;--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_totp" DROP COLUMN "failed_confirm_attempts";--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_challenges" DROP COLUMN "attempts";--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_verifications" DROP CONSTRAINT "mfa_verifications_pkey";--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_verifications" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_verifications" ALTER COLUMN "key_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_verifications_key_id_idx" ON "spfn_auth"."mfa_verifications" ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_verifications_profile_idx" ON "spfn_auth"."mfa_verifications" ("user_id","profile","profile_key_id");--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_attempt_budgets" ADD CONSTRAINT "mfa_attempt_budgets_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "spfn_auth"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_verifications" ADD CONSTRAINT "mfa_verifications_one_credential" CHECK (("key_id" IS NULL) = ("profile" IS NOT NULL)
            AND ("profile" IS NULL) = ("profile_key_id" IS NULL));