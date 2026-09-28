CREATE TABLE "spfn_notification"."push_devices" (
	"id" bigserial PRIMARY KEY,
	"owner_id" text NOT NULL,
	"device_id" text,
	"platform" text NOT NULL,
	"token" text NOT NULL,
	"locale" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_token_idx" ON "spfn_notification"."push_devices" ("token");--> statement-breakpoint
CREATE INDEX "push_devices_owner_idx" ON "spfn_notification"."push_devices" ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_active_device_idx" ON "spfn_notification"."push_devices" ("device_id") WHERE "device_id" is not null and "invalidated_at" is null;