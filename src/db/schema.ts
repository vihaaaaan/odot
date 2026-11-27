import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const currentUserId = sql`nullif(current_setting('app.user_id', true), '')`;

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().default(currentUserId),
  name: text("name").notNull(),
  description: text("description"),
  important: boolean("important").notNull().default(false),
  dueDate: date("due_date", { mode: "string" }),
  orderKey: text("order_key").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  check("tasks_name_not_blank", sql`length(btrim(${table.name})) > 0`),
  check("tasks_user_id_not_blank", sql`length(btrim(${table.userId})) > 0`),
  unique("tasks_user_id_id_unique").on(table.userId, table.id),
  uniqueIndex("tasks_order_key_unique").on(table.userId, sql`${table.orderKey} collate "C"`),
  index("tasks_due_date_idx").on(table.userId, table.dueDate),
  pgPolicy("tasks_owner", { for: "all", to: "public", using: sql`${table.userId} = ${currentUserId}`, withCheck: sql`${table.userId} = ${currentUserId}` }),
]).enableRLS();

export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().default(currentUserId),
  name: text("name").notNull(),
  description: text("description"),
}, (table) => [
  check("tags_name_not_blank", sql`length(btrim(${table.name})) > 0`),
  check("tags_user_id_not_blank", sql`length(btrim(${table.userId})) > 0`),
  unique("tags_user_id_id_unique").on(table.userId, table.id),
  uniqueIndex("tags_name_unique").on(table.userId, sql`lower(${table.name})`),
  pgPolicy("tags_owner", { for: "all", to: "public", using: sql`${table.userId} = ${currentUserId}`, withCheck: sql`${table.userId} = ${currentUserId}` }),
]).enableRLS();

export const taskTags = pgTable("task_tags", {
  userId: text("user_id").notNull().default(currentUserId),
  taskId: uuid("task_id").notNull(),
  tagId: uuid("tag_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.taskId, table.tagId] }),
  check("task_tags_user_id_not_blank", sql`length(btrim(${table.userId})) > 0`),
  foreignKey({ columns: [table.userId, table.taskId], foreignColumns: [tasks.userId, tasks.id], name: "task_tags_owner_task_fk" }).onDelete("cascade"),
  foreignKey({ columns: [table.userId, table.tagId], foreignColumns: [tags.userId, tags.id], name: "task_tags_owner_tag_fk" }).onDelete("cascade"),
  index("task_tags_tag_id_idx").on(table.userId, table.tagId),
  pgPolicy("task_tags_owner", { for: "all", to: "public", using: sql`${table.userId} = ${currentUserId}`, withCheck: sql`${table.userId} = ${currentUserId}` }),
]).enableRLS();

export type Task = typeof tasks.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type TaskWithTags = Task & { tags: Tag[] };
