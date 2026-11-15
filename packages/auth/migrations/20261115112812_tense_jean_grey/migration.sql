ALTER TABLE "spfn_auth"."user_public_keys" ADD COLUMN "replaced_by_key_id" text;--> statement-breakpoint
ALTER TABLE "spfn_auth"."webauthn_challenges" ADD COLUMN "started_by_key_id" text;--> statement-breakpoint
ALTER TABLE "spfn_auth"."webauthn_challenges" ADD COLUMN "started_by_profile" text;--> statement-breakpoint
ALTER TABLE "spfn_auth"."webauthn_challenges" ADD COLUMN "key_epoch" integer;--> statement-breakpoint
ALTER TABLE "spfn_auth"."webauthn_challenges" ADD COLUMN "password_proven_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_totp" ADD COLUMN "started_by_key_id" text;--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_totp" ADD COLUMN "started_by_profile" text;--> statement-breakpoint
ALTER TABLE "spfn_auth"."mfa_totp" ADD COLUMN "key_epoch" integer;