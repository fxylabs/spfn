ALTER TABLE "spfn_auth"."user_invitations" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_invitations" ADD CONSTRAINT "user_invitations_token_hash_key" UNIQUE("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_token_hash_idx" ON "spfn_auth"."user_invitations" ("token_hash");--> statement-breakpoint
UPDATE "spfn_auth"."user_invitations" SET "token_hash" = rtrim(translate(encode(sha256(convert_to("token", 'UTF8')), 'base64'), '+/', '-_'), '=') WHERE "token_hash" IS NULL;
