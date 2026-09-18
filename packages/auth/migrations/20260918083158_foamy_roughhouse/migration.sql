CREATE TABLE "spfn_auth"."oauth2_clients" (
	"id" bigserial PRIMARY KEY,
	"client_id" text NOT NULL UNIQUE,
	"client_name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"created_ip" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spfn_auth"."oauth2_grants" (
	"id" bigserial PRIMARY KEY,
	"oauth2_client_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"resource" text NOT NULL,
	"scopes" text[] NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spfn_auth"."oauth2_authorization_codes" (
	"id" bigserial PRIMARY KEY,
	"code_hash" text NOT NULL UNIQUE,
	"oauth2_grant_id" bigint NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spfn_auth"."oauth2_tokens" (
	"id" bigserial PRIMARY KEY,
	"token_hash" text NOT NULL UNIQUE,
	"kind" text NOT NULL,
	"oauth2_grant_id" bigint NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth2_grant_client_user_resource_idx" ON "spfn_auth"."oauth2_grants" ("oauth2_client_id","user_id","resource");--> statement-breakpoint
CREATE INDEX "oauth2_grant_user_idx" ON "spfn_auth"."oauth2_grants" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth2_token_grant_idx" ON "spfn_auth"."oauth2_tokens" ("oauth2_grant_id");--> statement-breakpoint
ALTER TABLE "spfn_auth"."oauth2_grants" ADD CONSTRAINT "oauth2_grants_oauth2_client_id_oauth2_clients_id_fkey" FOREIGN KEY ("oauth2_client_id") REFERENCES "spfn_auth"."oauth2_clients"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spfn_auth"."oauth2_grants" ADD CONSTRAINT "oauth2_grants_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "spfn_auth"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spfn_auth"."oauth2_authorization_codes" ADD CONSTRAINT "oauth2_authorization_codes_vL0GWtxW3xnt_fkey" FOREIGN KEY ("oauth2_grant_id") REFERENCES "spfn_auth"."oauth2_grants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spfn_auth"."oauth2_tokens" ADD CONSTRAINT "oauth2_tokens_oauth2_grant_id_oauth2_grants_id_fkey" FOREIGN KEY ("oauth2_grant_id") REFERENCES "spfn_auth"."oauth2_grants"("id") ON DELETE CASCADE;