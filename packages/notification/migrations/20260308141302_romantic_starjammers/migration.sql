CREATE TABLE "spfn_notification"."tracking_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"notification_id" integer NOT NULL,
	"type" text NOT NULL,
	"link_url" text,
	"link_index" integer,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "te_notification_id_idx" ON "spfn_notification"."tracking_events" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "te_type_idx" ON "spfn_notification"."tracking_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "te_created_at_idx" ON "spfn_notification"."tracking_events" USING btree ("created_at");