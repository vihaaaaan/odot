import { z } from "@hono/zod-openapi";
import type { createTodoApp } from "../index.js";
import type { Tag, Task } from "../db/schema.js";
import { entityId } from "../shared/validation.js";

export type Application = ReturnType<typeof createTodoApp>;
export type ApiEnvironment = { Variables: { todo: ReturnType<Application["forUser"]> } };

export const idParams = z.object({ id: entityId });
export const taskTagParams = idParams.extend({ tagId: entityId });
export const completionInput = z.strictObject({ completed: z.boolean() });

export const tagResponse = z.object({
  id: entityId,
  name: z.string(),
  description: z.string().nullable(),
}).openapi("Tag");

export const taskResponse = z.object({
  id: entityId,
  name: z.string(),
  description: z.string().nullable(),
  important: z.boolean(),
  dueDate: z.iso.date().nullable(),
  orderKey: z.string(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).openapi("Task");

export const taskWithTagsResponse = taskResponse.extend({ tags: z.array(tagResponse) }).openapi("TaskWithTags");
export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
}).openapi("Error");

export function jsonResponse<Schema extends z.ZodType>(schema: Schema, description: string) {
  return { description, content: { "application/json": { schema } } };
}

export const errorResponses = {
  400: jsonResponse(errorResponse, "Invalid input or malformed JSON"),
  401: jsonResponse(errorResponse, "Missing or invalid Neon Auth bearer token"),
  404: jsonResponse(errorResponse, "Resource not found for the authenticated user"),
  409: jsonResponse(errorResponse, "Conflicting resource"),
  413: jsonResponse(errorResponse, "Request body exceeds 256 KiB"),
  415: jsonResponse(errorResponse, "Expected application/json"),
  500: jsonResponse(errorResponse, "Unexpected server error"),
};

export const bearerSecurity = [{ bearerAuth: [] }];

export function serializeTag(tag: Tag) {
  return { id: tag.id, name: tag.name, description: tag.description };
}

export function serializeTask(task: Task) {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    important: task.important,
    dueDate: task.dueDate,
    orderKey: task.orderKey,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}
