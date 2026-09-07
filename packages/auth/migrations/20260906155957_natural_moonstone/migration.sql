CREATE TABLE "spfn_auth"."passkeys" (
	"id" bigserial PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"credential_id" text NOT NULL UNIQUE,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" text[],
	"device_type" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"aaguid" text,
	"label" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spfn_auth"."webauthn_challenges" (
	"id" bigserial PRIMARY KEY,
	"challenge_hash" text NOT NULL,
	"kind" text NOT NULL,
	"user_id" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "passkeys_user_id_idx" ON "spfn_auth"."passkeys" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webauthn_challenge_hash_idx" ON "spfn_auth"."webauthn_challenges" ("challenge_hash");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_at_idx" ON "spfn_auth"."webauthn_challenges" ("expires_at");--> statement-breakpoint
ALTER TABLE "spfn_auth"."passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "spfn_auth"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spfn_auth"."webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "spfn_auth"."users"("id") ON DELETE CASCADE;