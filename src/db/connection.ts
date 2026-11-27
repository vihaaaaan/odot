import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { PoolConfig } from "pg";
import * as schema from "./schema.js";

export function createDatabase(connection: string | PoolConfig) {
  const pool = new Pool(typeof connection === "string" ? { connectionString: connection } : connection);
  const database = drizzle(pool, { schema });
  return { database, close: () => pool.end() };
}

export type Database = ReturnType<typeof createDatabase>["database"];
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DatabaseSession = Database | Transaction;
