ALTER TABLE "spfn_auth"."users" ADD COLUMN "session_binding" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "spfn_auth"."users" ADD COLUMN "session_binding_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_public_keys" ADD COLUMN "registered_ua_family" text;--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_public_keys" ADD COLUMN "binding" text DEFAULT 'none' NOT NULL;