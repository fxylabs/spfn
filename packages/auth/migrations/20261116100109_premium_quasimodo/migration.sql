ALTER TABLE "spfn_auth"."user_public_keys" ADD COLUMN "via_web_proxy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill what the rows already prove about the keys registered before the column:
-- - binding = 'passkey': a bound key was only ever registered through the trusted proxy.
-- - last_seen_ip IS NOT NULL: the throttled last-use statement writes it only from a request
--   proxy-guard attested as the proxy's (attestedClientIp) and overwrites it with NULL otherwise,
--   so a stored address means the key's last recorded use came through the proxy.
-- client_kind is not a proxy signal: the proxy never forwards x-spfn-client-kind, so ios/android
-- marks a key a native SDK used directly, and such a key with no stored address stays false.
-- Every key neither signal classifies stays false and becomes a web key at its first use through
-- the proxy, where a key of a bound account is bound (bindWebKeyOnFirstUseService).
UPDATE "spfn_auth"."user_public_keys" SET "via_web_proxy" = true WHERE "binding" = 'passkey' OR "last_seen_ip" IS NOT NULL;
