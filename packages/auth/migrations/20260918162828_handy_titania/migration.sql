CREATE TABLE "spfn_auth"."mfa_totp" (
	"id" bigserial PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"secret_enc" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_step" bigint,
	"failed_confirm_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spfn_auth"."mfa_recovery_codes" (
	"id" bigserial PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"generation" integer NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spfn_auth"."mfa_verifications" (
	"key_id" text PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"method" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spfn_auth"."passkeys" ADD COLUMN "second_factor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_totp_user_id_idx" ON "spfn_auth"."mfa_totp" ("user_id");--> statement-breakpoint
CREATE INDEX "mfa_recovery_codes_user_generation_idx" ON "spfn_auth"."mfa_recovery_codes" ("user_id","generation");--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_totp" ADD CONSTRAINT "mfa_totp_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "spfn_auth"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "spfn_auth"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_verifications" ADD CONSTRAINT "mfa_verifications_key_id_user_public_keys_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "spfn_auth"."user_public_keys"("key_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_verifications" ADD CONSTRAINT "mfa_verifications_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "spfn_auth"."users"("id") ON DELETE CASCADE;