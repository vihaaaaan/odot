import { asc, eq } from "drizzle-orm";
import type { DatabaseSession, Transaction } from "../db/connection.js";
import { tags } from "../db/schema.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";
import type { UpdateTagInput } from "./inputs.js";

function postgresCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return postgresCode(error.cause);
}

async function tagWrite<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (postgresCode(error) === "23505") {
      throw new ConflictError("A tag with that name already exists (case-insensitive)", { cause: error });
    }
    throw error;
  }
}

export async function getTagOrThrow(database: DatabaseSession, id: string) {
  const [tag] = await database.select().from(tags).where(eq(tags.id, id));
  if (!tag) throw new NotFoundError("Tag", id);
  return tag;
}

export async function lockTagForReference(transaction: Transaction, id: string) {
  await transaction.select({ id: tags.id }).from(tags).where(eq(tags.id, id)).for("key share");
  return getTagOrThrow(transaction, id);
}

export async function selectTags(database: DatabaseSession) {
  return database.select().from(tags).orderBy(asc(tags.name), asc(tags.id));
}

export async function insertTag(database: DatabaseSession, fields: typeof tags.$inferInsert) {
  return tagWrite(async () => {
    const [tag] = await database.insert(tags).values(fields).returning();
    if (!tag) throw new Error("Tag insert returned no row");
    return tag;
  });
}

export async function updateTag(database: DatabaseSession, id: string, fields: UpdateTagInput) {
  return tagWrite(async () => {
    const [tag] = await database.update(tags).set(fields).where(eq(tags.id, id)).returning();
    if (!tag) throw new NotFoundError("Tag", id);
    return tag;
  });
}

export async function deleteTag(database: DatabaseSession, id: string): Promise<void> {
  const deleted = await database.delete(tags).where(eq(tags.id, id)).returning({ id: tags.id });
  if (!deleted.length) throw new NotFoundError("Tag", id);
}
