ALTER TABLE "spfn_auth"."user_public_keys" ADD COLUMN "registered_ip" text;--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_public_keys" ADD COLUMN "registered_user_agent" text;