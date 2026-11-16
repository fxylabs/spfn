ALTER TABLE "spfn_auth"."users" RENAME CONSTRAINT "users_role_id_roles_id_fk" TO "users_role_id_roles_id_fkey";--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_invitations" RENAME CONSTRAINT "user_invitations_role_id_roles_id_fk" TO "user_invitations_role_id_roles_id_fkey";--> statement-breakpoint
ALTER TABLE "spfn_auth"."roles" ADD COLUMN "source" text DEFAULT 'config' NOT NULL;--> statement-breakpoint
ALTER TABLE "spfn_auth"."role_permissions" ADD COLUMN "source" text DEFAULT 'config' NOT NULL;--> statement-breakpoint
ALTER TABLE "spfn_auth"."ops_tokens" ADD COLUMN "issued_by_id" bigint;--> statement-breakpoint
ALTER TABLE "spfn_auth"."ops_tokens" ADD CONSTRAINT "ops_tokens_issued_by_id_users_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "spfn_auth"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spfn_auth"."users" DROP CONSTRAINT "users_role_id_roles_id_fkey", ADD CONSTRAINT "users_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "spfn_auth"."roles"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "spfn_auth"."user_invitations" DROP CONSTRAINT "user_invitations_role_id_roles_id_fkey", ADD CONSTRAINT "user_invitations_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "spfn_auth"."roles"("id") ON DELETE RESTRICT;