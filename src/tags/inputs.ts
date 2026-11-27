import { z } from "zod";
import { description, hasDefinedField, name } from "../shared/validation.js";

export const createTagInput = z.strictObject({ name, description: description.optional() });
export const updateTagInput = createTagInput.partial().refine(hasDefinedField, "Provide at least one field");

export type CreateTagInput = z.input<typeof createTagInput>;
export type UpdateTagInput = z.input<typeof updateTagInput>;
