CREATE TABLE "spfn_auth"."user_settings" (
	"id" bigserial PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_settings_user_id_key_idx" ON "spfn_auth"."user_settings" ("user_id","key");--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "spfn_auth"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_settings" ADD CONSTRAINT "user_settings_updated_by_id_users_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "spfn_auth"."users"("id") ON DELETE SET NULL;--> statement-breakpoint
INSERT INTO "spfn_auth"."user_settings" ("user_id", "key", "value", "updated_by_id", "created_at", "updated_at")
SELECT "user_id", 'locale', to_jsonb("locale"), "user_id", "updated_at", "updated_at"
FROM "spfn_auth"."user_profiles" WHERE "locale" IS NOT NULL
ON CONFLICT ("user_id", "key") DO NOTHING;--> statement-breakpoint
INSERT INTO "spfn_auth"."user_settings" ("user_id", "key", "value", "updated_by_id", "created_at", "updated_at")
SELECT "user_id", 'timezone', to_jsonb("timezone"), "user_id", "updated_at", "updated_at"
FROM "spfn_auth"."user_profiles" WHERE NULLIF(btrim("timezone"), '') IS NOT NULL AND "timezone" <> 'UTC'
ON CONFLICT ("user_id", "key") DO NOTHING;
