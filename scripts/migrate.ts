import "dotenv/config";
import { migrateDatabase } from "../src/index.js";

const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error("Set MIGRATION_DATABASE_URL in your environment or .env file before migrating");
await migrateDatabase(connectionString);
console.log("Database migrations applied.");
