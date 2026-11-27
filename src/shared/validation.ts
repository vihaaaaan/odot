import { z } from "zod";

export const entityId = z.uuid();
export const userIdInput = z.string().min(1).max(256).refine((value) => value.trim() === value && !value.includes("\0"), "Invalid user ID");
export const name = z.string().trim().min(1).max(500);
export const description = z.string().max(50_000).nullable();

export function hasDefinedField(input: Record<string, unknown>): boolean {
  return Object.values(input).some((value) => value !== undefined);
}
