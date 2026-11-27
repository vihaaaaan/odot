import { z } from "zod";
import type { TenantDatabase } from "../db/tenant.js";
import type { Task, TaskWithTags } from "../db/schema.js";
import { entityId } from "../shared/validation.js";
import { getTagOrThrow, lockTagForReference } from "../tags/queries.js";
import { getAppendOrderKey, getMovedOrderKey } from "./ordering.js";
import {
  deleteTask, deleteTaskTag, getTaskOrThrow, insertTask, insertTaskTags, lockTaskForUpdate,
  lockTaskOrder, selectTasks, setTaskCompleted, updateTask, withTags,
} from "./queries.js";
import { createTaskInput, listTasksInput, moveTaskInput, updateTaskInput } from "./inputs.js";
import type { CreateTaskInput, ListTasksInput, MoveTaskInput, UpdateTaskInput } from "./inputs.js";

export function createTaskService(database: TenantDatabase) {
  return {
    async create(input: CreateTaskInput): Promise<TaskWithTags> {
      const { tagIds = [], ...fields } = createTaskInput.parse(input);
      return database.transaction(async (transaction) => {
        await lockTaskOrder(transaction);
        const uniqueTagIds = [...new Set(tagIds)].sort();
        for (const tagId of uniqueTagIds) await lockTagForReference(transaction, tagId);
        const orderKey = await getAppendOrderKey(transaction);
        const task = await insertTask(transaction, { ...fields, orderKey });
        await insertTaskTags(transaction, task.id, uniqueTagIds);
        return (await withTags(transaction, [task]))[0]!;
      });
    },

    async get(id: string): Promise<TaskWithTags> {
      entityId.parse(id);
      return database.transaction(async (transaction) => {
        const task = await getTaskOrThrow(transaction, id);
        return (await withTags(transaction, [task]))[0]!;
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async list(input: ListTasksInput = {}): Promise<TaskWithTags[]> {
      const options = listTasksInput.parse(input);
      return database.transaction(async (transaction) => {
        const rows = await selectTasks(transaction, options);
        return withTags(transaction, rows);
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async update(id: string, input: UpdateTaskInput): Promise<Task> {
      entityId.parse(id);
      const fields = updateTaskInput.parse(input);
      return database.transaction((transaction) => updateTask(transaction, id, fields));
    },

    async setCompleted(id: string, completed: boolean): Promise<Task> {
      entityId.parse(id);
      z.boolean().parse(completed);
      return database.transaction((transaction) => setTaskCompleted(transaction, id, completed));
    },

    async move(id: string, input: MoveTaskInput): Promise<Task> {
      entityId.parse(id);
      const placement = moveTaskInput.parse(input);
      if ("targetId" in placement && placement.targetId === id) {
        throw new z.ZodError([{ code: "custom", path: ["targetId"], message: "Cannot move a task relative to itself" }]);
      }
      return database.transaction(async (transaction) => {
        await lockTaskOrder(transaction);
        await getTaskOrThrow(transaction, id);
        const orderKey = await getMovedOrderKey(transaction, id, placement);
        return updateTask(transaction, id, { orderKey });
      });
    },

    async attachTag(taskId: string, tagId: string): Promise<void> {
      entityId.parse(taskId);
      entityId.parse(tagId);
      await database.transaction(async (transaction) => {
        await lockTaskForUpdate(transaction, taskId);
        await lockTagForReference(transaction, tagId);
        await insertTaskTags(transaction, taskId, [tagId]);
        await updateTask(transaction, taskId, {});
      });
    },

    async detachTag(taskId: string, tagId: string): Promise<void> {
      entityId.parse(taskId);
      entityId.parse(tagId);
      await database.transaction(async (transaction) => {
        await lockTaskForUpdate(transaction, taskId);
        await getTagOrThrow(transaction, tagId);
        await deleteTaskTag(transaction, taskId, tagId);
        await updateTask(transaction, taskId, {});
      });
    },

    async delete(id: string): Promise<void> {
      entityId.parse(id);
      await database.transaction(async (transaction) => {
        await lockTaskOrder(transaction);
        await deleteTask(transaction, id);
      });
    },
  };
}
