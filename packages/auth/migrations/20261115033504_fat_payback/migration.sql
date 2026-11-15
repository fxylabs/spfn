ALTER TABLE "spfn_auth"."user_public_keys" ADD COLUMN "key_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_public_keys" ADD COLUMN "authenticated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "spfn_auth"."user_public_keys" k SET "key_epoch" = u."key_epoch", "authenticated_at" = k."created_at" FROM "spfn_auth"."users" u WHERE u."id" = k."user_id";
