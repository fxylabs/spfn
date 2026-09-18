CREATE TABLE "spfn_auth"."key_revoke_all_tokens" (
	"id" bigserial PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spfn_auth"."users" ADD COLUMN "key_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "key_revoke_all_token_hash_idx" ON "spfn_auth"."key_revoke_all_tokens" ("token_hash");--> statement-breakpoint
CREATE INDEX "key_revoke_all_user_id_idx" ON "spfn_auth"."key_revoke_all_tokens" ("user_id");--> statement-breakpoint
CREATE INDEX "key_revoke_all_expires_at_idx" ON "spfn_auth"."key_revoke_all_tokens" ("expires_at");--> statement-breakpoint
ALTER TABLE "spfn_auth"."key_revoke_all_tokens" ADD CONSTRAINT "key_revoke_all_tokens_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "spfn_auth"."users"("id") ON DELETE CASCADE;