CREATE TABLE "spfn_auth"."device_links" (
	"id" bigserial PRIMARY KEY,
	"link_id" text NOT NULL UNIQUE,
	"user_code" text NOT NULL,
	"issuer_user_id" bigint NOT NULL,
	"issuer_key_id" text NOT NULL,
	"device_code_hash" text UNIQUE,
	"public_key" text,
	"key_id" text,
	"fingerprint" text,
	"algorithm" text,
	"device_name" text,
	"platform" text,
	"match_number" integer,
	"choices" integer[],
	"status" text DEFAULT 'issued' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "device_link_user_code_idx" ON "spfn_auth"."device_links" ("user_code");--> statement-breakpoint
CREATE INDEX "device_link_issuer_key_idx" ON "spfn_auth"."device_links" ("issuer_key_id");--> statement-breakpoint
CREATE INDEX "device_link_issuer_user_idx" ON "spfn_auth"."device_links" ("issuer_user_id");--> statement-breakpoint
ALTER TABLE "spfn_auth"."device_links" ADD CONSTRAINT "device_links_issuer_user_id_users_id_fkey" FOREIGN KEY ("issuer_user_id") REFERENCES "spfn_auth"."users"("id") ON DELETE CASCADE;