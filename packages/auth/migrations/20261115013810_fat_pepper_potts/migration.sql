UPDATE "spfn_auth"."user_invitations" SET "token_hash" = rtrim(translate(encode(sha256(convert_to("token", 'UTF8')), 'base64'), '+/', '-_'), '=') WHERE "token_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_invitations" DROP CONSTRAINT "user_invitations_token_unique";--> statement-breakpoint
DROP INDEX "spfn_auth"."invitations_token_idx";--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_invitations" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_invitations" ALTER COLUMN "token_hash" SET NOT NULL;