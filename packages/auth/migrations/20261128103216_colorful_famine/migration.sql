ALTER TABLE "spfn_auth"."device_links" ADD COLUMN "reach" text;--> statement-breakpoint
ALTER TABLE "spfn_auth"."device_links" ADD COLUMN "key_lifetime_ms" bigint;--> statement-breakpoint
ALTER TABLE "spfn_auth"."device_links" ADD CONSTRAINT "device_links_narrowing_whole" CHECK (("reach" IS NULL) = ("key_lifetime_ms" IS NULL));