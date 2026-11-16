-- Clear every recorded browser family of 'other', on every key, bound or not.
-- Before the bound-family check moved to admission, a sign-in completed through a server-side hop
-- recorded the hop's own user-agent (Node's `node`, or the app's HTTP client) as the family, and
-- renewal and rotation carried it on. Such a value is no fact about a browser, and nothing told it
-- apart from one that is: no list of server-client user-agents is complete. What is certain is that
-- a browser of the five-badge table never reads as 'other', and that 'other' was compared before
-- only for keys whose cookie was sealed bound. A cleared key is not compared until its next passkey
-- renewal records the family of the renewing request — 'other' again for a browser that reads so.
UPDATE "spfn_auth"."user_public_keys" SET "registered_ua_family" = NULL WHERE "registered_ua_family" = 'other';
