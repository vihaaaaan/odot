import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DatabaseSession, Transaction } from "../db/connection.js";
import { tags, tasks, taskTags } from "../db/schema.js";
import type { Tag, Task, TaskWithTags } from "../db/schema.js";
import { NotFoundError } from "../shared/errors.js";
import type { ListTasksOptions, UpdateTaskInput } from "./inputs.js";

const manualOrder = sql`${tasks.orderKey} collate "C"`;

export async function withTags(database: DatabaseSession, rows: Task[]): Promise<TaskWithTags[]> {
  if (!rows.length) return [];
  const associations = await database.select({ taskId: taskTags.taskId, tag: tags }).from(taskTags)
    .innerJoin(tags, eq(tags.id, taskTags.tagId)).where(inArray(taskTags.taskId, rows.map((task) => task.id)))
    .orderBy(asc(tags.name), asc(tags.id));
  const byTask = new Map<string, Tag[]>();
  for (const association of associations) {
    const attached = byTask.get(association.taskId) ?? [];
    attached.push(association.tag);
    byTask.set(association.taskId, attached);
  }
  return rows.map((task) => ({ ...task, tags: byTask.get(task.id) ?? [] }));
}

export async function insertTaskTags(database: DatabaseSession, taskId: string, tagIds: string[]): Promise<void> {
  if (!tagIds.length) return;
  await database.insert(taskTags).values(tagIds.map((tagId) => ({ taskId, tagId }))).onConflictDoNothing();
}

export async function deleteTaskTag(database: DatabaseSession, taskId: string, tagId: string): Promise<void> {
  await database.delete(taskTags).where(and(eq(taskTags.taskId, taskId), eq(taskTags.tagId, tagId)));
}

export async function getTaskOrThrow(database: DatabaseSession, id: string) {
  const [task] = await database.select().from(tasks).where(eq(tasks.id, id));
  if (!task) throw new NotFoundError("Task", id);
  return task;
}

export async function lockTaskForUpdate(transaction: Transaction, id: string) {
  await transaction.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).for("update");
  return getTaskOrThrow(transaction, id);
}

export async function insertTask(database: DatabaseSession, fields: typeof tasks.$inferInsert) {
  const [task] = await database.insert(tasks).values(fields).returning();
  if (!task) throw new Error("Task insert returned no row");
  return task;
}

export async function updateTask(database: DatabaseSession, id: string, fields: UpdateTaskInput & { orderKey?: string }) {
  const [task] = await database.update(tasks).set({ ...fields, updatedAt: new Date() })
    .where(eq(tasks.id, id)).returning();
  if (!task) throw new NotFoundError("Task", id);
  return task;
}

export async function setTaskCompleted(database: DatabaseSession, id: string, completed: boolean) {
  const [task] = await database.update(tasks).set({
    completedAt: completed ? sql`coalesce(${tasks.completedAt}, now())` : null,
    updatedAt: new Date(),
  }).where(eq(tasks.id, id)).returning();
  if (!task) throw new NotFoundError("Task", id);
  return task;
}

export async function deleteTask(database: DatabaseSession, id: string): Promise<void> {
  const deleted = await database.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id });
  if (!deleted.length) throw new NotFoundError("Task", id);
}

export async function selectTasks(database: DatabaseSession, options: ListTasksOptions) {
  const filters: SQL[] = [];
  if (options.status === "incomplete") filters.push(isNull(tasks.completedAt));
  if (options.status === "completed") filters.push(isNotNull(tasks.completedAt));
  if (options.important !== undefined) filters.push(eq(tasks.important, options.important));
  for (const tagId of new Set(options.tagIds)) {
    filters.push(exists(database.select({ taskId: taskTags.taskId }).from(taskTags)
      .where(and(eq(taskTags.taskId, tasks.id), eq(taskTags.tagId, tagId)))));
  }

  let ordering = [asc(manualOrder)];
  if (options.sort === "due_date") ordering = [sql`${tasks.dueDate} asc nulls last`, asc(manualOrder)];
  if (options.sort === "important") ordering = [desc(tasks.important), asc(manualOrder)];

  return database.select().from(tasks).where(and(...filters)).orderBy(...ordering)
    .limit(options.limit).offset(options.offset);
}

export async function lockTaskOrder(transaction: Transaction) {
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(current_setting('app.user_id'), 71024))`);
}

export async function getLastOrderKey(transaction: Transaction) {
  const [last] = await transaction.select({ orderKey: tasks.orderKey }).from(tasks)
    .orderBy(desc(manualOrder)).limit(1);
  return last?.orderKey ?? null;
}

export async function getBoundaryOrderKey(transaction: Transaction, excludedId: string, edge: "first" | "last") {
  const [neighbor] = await transaction.select({ orderKey: tasks.orderKey }).from(tasks)
    .where(ne(tasks.id, excludedId)).orderBy(edge === "first" ? asc(manualOrder) : desc(manualOrder)).limit(1);
  return neighbor?.orderKey ?? null;
}

export async function getAdjacentOrderKey(
  transaction: Transaction,
  excludedId: string,
  targetKey: string,
  direction: "before" | "after",
) {
  const before = direction === "before";
  const [neighbor] = await transaction.select({ orderKey: tasks.orderKey }).from(tasks)
    .where(and(ne(tasks.id, excludedId), before ? sql`${manualOrder} < ${targetKey} collate "C"`
      : sql`${manualOrder} > ${targetKey} collate "C"`))
    .orderBy(before ? desc(manualOrder) : asc(manualOrder)).limit(1);
  return neighbor?.orderKey ?? null;
}
