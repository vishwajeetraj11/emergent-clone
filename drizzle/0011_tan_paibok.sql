ALTER TABLE "files" ADD COLUMN "hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auth_secret" text;--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "content";