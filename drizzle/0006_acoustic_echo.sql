ALTER TABLE "users" ADD COLUMN "github_user_access_token" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_user_refresh_token" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_user_token_expires_at" timestamp with time zone;