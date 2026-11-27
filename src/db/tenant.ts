import { sql } from "drizzle-orm";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import type { Database, Transaction } from "./connection.js";
import { userIdInput } from "../shared/validation.js";

export function createTenantDatabase(database: Database, userId: string) {
  const validatedId = userIdInput.parse(userId);
  return {
    async transaction<Result>(operation: (transaction: Transaction) => Promise<Result>, config?: PgTransactionConfig): Promise<Result> {
      return database.transaction(async (transaction) => {
        const result = await transaction.execute<{ unsafe: boolean }>(sql`
          select (role.rolsuper or role.rolbypassrls or role.rolcreaterole or exists (
            select 1 from pg_class relation
            join pg_namespace namespace on namespace.oid = relation.relnamespace
            where namespace.nspname = 'public' and relation.relname in ('tasks', 'tags', 'task_tags')
              and (relation.relowner = role.oid or not relation.relrowsecurity or not relation.relforcerowsecurity)
          )) as unsafe from pg_roles role where role.rolname = current_user
        `);
        if (result.rows[0]?.unsafe !== false) {
          throw new Error("Unsafe runtime database role or missing RLS. Use a non-owner, non-superuser, NOBYPASSRLS role and apply migrations.");
        }
        await transaction.execute(sql`select set_config('app.user_id', ${validatedId}, true)`);
        return operation(transaction);
      }, config);
    },
  };
}

export type TenantDatabase = ReturnType<typeof createTenantDatabase>;
