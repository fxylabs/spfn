CREATE TABLE "spfn_auth"."password_reset_tokens" (
	"id" bigserial PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"return_path" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"setup_secret_hash" text,
	"setup_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_token_hash_idx" ON "spfn_auth"."password_reset_tokens" ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_setup_secret_hash_idx" ON "spfn_auth"."password_reset_tokens" ("setup_secret_hash");--> statement-breakpoint
CREATE INDEX "password_reset_user_id_idx" ON "spfn_auth"."password_reset_tokens" ("user_id");--> statement-breakpoint
CREATE INDEX "password_reset_expires_at_idx" ON "spfn_auth"."password_reset_tokens" ("expires_at");--> statement-breakpoint
ALTER TABLE "spfn_auth"."password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "spfn_auth"."users"("id") ON DELETE CASCADE;