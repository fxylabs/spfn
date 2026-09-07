ALTER TABLE "spfn_auth"."signup_link_tokens" ALTER COLUMN "token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "spfn_auth"."password_reset_tokens" ALTER COLUMN "token_hash" DROP NOT NULL;