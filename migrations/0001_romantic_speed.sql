DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "tasks") OR EXISTS (SELECT 1 FROM "tags") OR EXISTS (SELECT 1 FROM "task_tags") THEN
    RAISE EXCEPTION 'Per-user migration requires an empty database. Assign existing rows to verified user IDs in a reviewed backfill migration before proceeding.';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "task_tags" DROP CONSTRAINT "task_tags_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "task_tags" DROP CONSTRAINT "task_tags_tag_id_tags_id_fk";
--> statement-breakpoint
DROP INDEX "tags_name_unique";--> statement-breakpoint
DROP INDEX "task_tags_tag_id_idx";--> statement-breakpoint
DROP INDEX "tasks_order_key_unique";--> statement-breakpoint
DROP INDEX "tasks_due_date_idx";--> statement-breakpoint
ALTER TABLE "task_tags" DROP CONSTRAINT "task_tags_task_id_tag_id_pk";--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "user_id" text DEFAULT nullif(current_setting('app.user_id', true), '') NOT NULL;--> statement-breakpoint
ALTER TABLE "task_tags" ADD COLUMN "user_id" text DEFAULT nullif(current_setting('app.user_id', true), '') NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "user_id" text DEFAULT nullif(current_setting('app.user_id', true), '') NOT NULL;--> statement-breakpoint
ALTER TABLE "task_tags" ADD CONSTRAINT "task_tags_user_id_task_id_tag_id_pk" PRIMARY KEY("user_id","task_id","tag_id");--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_id_unique" UNIQUE("user_id","id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_id_unique" UNIQUE("user_id","id");--> statement-breakpoint
ALTER TABLE "task_tags" ADD CONSTRAINT "task_tags_owner_task_fk" FOREIGN KEY ("user_id","task_id") REFERENCES "public"."tasks"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tags" ADD CONSTRAINT "task_tags_owner_tag_fk" FOREIGN KEY ("user_id","tag_id") REFERENCES "public"."tags"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tags_name_unique" ON "tags" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "task_tags_tag_id_idx" ON "task_tags" USING btree ("user_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_order_key_unique" ON "tasks" USING btree ("user_id","order_key" collate "C");--> statement-breakpoint
CREATE INDEX "tasks_due_date_idx" ON "tasks" USING btree ("user_id","due_date");--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_not_blank" CHECK (length(btrim("tags"."user_id")) > 0);--> statement-breakpoint
ALTER TABLE "task_tags" ADD CONSTRAINT "task_tags_user_id_not_blank" CHECK (length(btrim("task_tags"."user_id")) > 0);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_not_blank" CHECK (length(btrim("tasks"."user_id")) > 0);--> statement-breakpoint
CREATE POLICY "tags_owner" ON "tags" AS PERMISSIVE FOR ALL TO public USING ("tags"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("tags"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "task_tags_owner" ON "task_tags" AS PERMISSIVE FOR ALL TO public USING ("task_tags"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("task_tags"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "tasks_owner" ON "tasks" AS PERMISSIVE FOR ALL TO public USING ("tasks"."user_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("tasks"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tags" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_tags" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
