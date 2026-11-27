import type { TenantDatabase } from "../db/tenant.js";
import { entityId } from "../shared/validation.js";
import { deleteTag, getTagOrThrow, insertTag, selectTags, updateTag } from "./queries.js";
import { createTagInput, updateTagInput } from "./inputs.js";
import type { CreateTagInput, UpdateTagInput } from "./inputs.js";

export function createTagService(database: TenantDatabase) {
  return {
    async create(input: CreateTagInput) {
      const fields = createTagInput.parse(input);
      return database.transaction((transaction) => insertTag(transaction, fields));
    },

    async get(id: string) {
      entityId.parse(id);
      return database.transaction((transaction) => getTagOrThrow(transaction, id));
    },

    async list() {
      return database.transaction((transaction) => selectTags(transaction));
    },

    async update(id: string, input: UpdateTagInput) {
      entityId.parse(id);
      const fields = updateTagInput.parse(input);
      return database.transaction((transaction) => updateTag(transaction, id, fields));
    },

    async delete(id: string): Promise<void> {
      entityId.parse(id);
      await database.transaction((transaction) => deleteTag(transaction, id));
    },
  };
}
