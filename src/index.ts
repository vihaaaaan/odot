import type { PoolConfig } from "pg";
import { createDatabase } from "./db/connection.js";
import { createTenantDatabase } from "./db/tenant.js";
import { createNeonTokenVerifier } from "./auth/neon.js";
import { createTagService } from "./tags/service.js";
import { createTaskService } from "./tasks/service.js";

export function createTodoApp(connection: string | PoolConfig, options: { authUrl?: string } = {}) {
  const verifyToken = options.authUrl ? createNeonTokenVerifier(options.authUrl) : undefined;
  const { database, close } = createDatabase(connection);
  const forUser = (userId: string) => {
    const tenantDatabase = createTenantDatabase(database, userId);
    return { tasks: createTaskService(tenantDatabase), tags: createTagService(tenantDatabase) };
  };
  return {
    forUser,
    async forToken(token: string) {
      if (!verifyToken) throw new Error("Configure authUrl before authenticating Neon Auth tokens");
      return forUser(await verifyToken(token));
    },
    close,
  };
}

export { migrateDatabase } from "./db/migrate.js";
export { AuthenticationError, ConflictError, NotFoundError } from "./shared/errors.js";
export { createNeonTokenVerifier } from "./auth/neon.js";
export { ZodError as ValidationError } from "zod";
export type { Task, Tag, TaskWithTags } from "./db/schema.js";
export type {
  CreateTaskInput, UpdateTaskInput, ListTasksInput, MoveTaskInput,
} from "./tasks/inputs.js";
export type { CreateTagInput, UpdateTagInput } from "./tags/inputs.js";
