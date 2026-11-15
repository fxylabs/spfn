ALTER TABLE "spfn_auth"."users" ADD COLUMN "deletion" text;--> statement-breakpoint
-- Backfill: the deletion procedure leaves users.status for users.deletion.
-- The status before the request was not kept (the request overwrote it), so a
-- pending account becomes active, and a purged one inactive: neither can sign
-- in, since users.deletion refuses both. Purge dates and request rows are untouched.
UPDATE "spfn_auth"."users" SET "deletion" = 'pending', "status" = 'active' WHERE "status" = 'pending_deletion';--> statement-breakpoint
UPDATE "spfn_auth"."users" SET "deletion" = 'deleted', "status" = 'inactive' WHERE "status" = 'deleted';
