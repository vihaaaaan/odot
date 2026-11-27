import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PoolConfig } from "pg";
import { createDatabase } from "./connection.js";

export async function migrateDatabase(connection: string | PoolConfig) {
  const { database, close } = createDatabase(connection);
  try {
    await migrate(database, {
      migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
    });
  } finally {
    await close();
  }
}
