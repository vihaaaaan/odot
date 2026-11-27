import { z } from "zod";
import { description, entityId, hasDefinedField, name } from "../shared/validation.js";

const dueDate = z.iso.date().nullable();

export const createTaskInput = z.strictObject({
  name,
  description: description.optional(),
  important: z.boolean().optional(),
  dueDate: dueDate.optional(),
  tagIds: z.array(entityId).max(100).optional(),
});

export const updateTaskInput = z.strictObject({
  name: name.optional(),
  description: description.optional(),
  important: z.boolean().optional(),
  dueDate: dueDate.optional(),
}).refine(hasDefinedField, "Provide at least one field");

export const listTasksInput = z.strictObject({
  status: z.enum(["incomplete", "completed", "all"]).default("incomplete"),
  sort: z.enum(["manual", "due_date", "important"]).default("manual"),
  tagIds: z.array(entityId).max(100).default([]),
  important: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});

export const moveTaskInput = z.discriminatedUnion("placement", [
  z.strictObject({ placement: z.literal("first") }),
  z.strictObject({ placement: z.literal("last") }),
  z.strictObject({ placement: z.literal("before"), targetId: entityId }),
  z.strictObject({ placement: z.literal("after"), targetId: entityId }),
]);

export type CreateTaskInput = z.input<typeof createTaskInput>;
export type UpdateTaskInput = z.input<typeof updateTaskInput>;
export type ListTasksInput = z.input<typeof listTasksInput>;
export type MoveTaskInput = z.input<typeof moveTaskInput>;
export type ListTasksOptions = z.output<typeof listTasksInput>;
