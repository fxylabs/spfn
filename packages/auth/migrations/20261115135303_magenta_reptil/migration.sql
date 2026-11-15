CREATE TABLE "spfn_auth"."account_exists_notices" (
	"target" text PRIMARY KEY,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Backfill: the notice window used to be a never-sent 'registration' code living
-- 60 minutes (a real code lives 5). Carry the windows still running over, keyed by
-- the folded address, then remove every such row from verification_codes so the
-- verify route can no longer read one.
INSERT INTO "spfn_auth"."account_exists_notices" ("target", "sent_at")
SELECT DISTINCT ON (folded) folded, "created_at"
FROM (
	SELECT
		CASE WHEN "target_type" = 'email' THEN lower(btrim("target")) ELSE btrim("target") END AS folded,
		"created_at"
	FROM "spfn_auth"."verification_codes"
	WHERE "purpose" = 'registration'
		AND "used_at" IS NULL
		AND "expires_at" > now()
		AND "expires_at" - "created_at" > interval '10 minutes'
) AS markers
ORDER BY folded, "created_at" DESC
ON CONFLICT ("target") DO NOTHING;--> statement-breakpoint
DELETE FROM "spfn_auth"."verification_codes"
WHERE "purpose" = 'registration'
	AND "expires_at" - "created_at" > interval '10 minutes';
