ALTER TABLE "projects" ADD COLUMN "neon_project_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "neon_branch_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "database_url" text;