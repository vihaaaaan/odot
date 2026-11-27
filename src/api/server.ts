import "dotenv/config";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { createTodoApp } from "../index.js";
import { createApi } from "./index.js";

const environment = z.object({
  DATABASE_URL: z.string().min(1),
  NEON_AUTH_BASE_URL: z.url(),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGINS: z.string().optional(),
}).parse(process.env);

const application = createTodoApp(environment.DATABASE_URL, { authUrl: environment.NEON_AUTH_BASE_URL });
const api = createApi(application, {
  allowedOrigins: environment.CORS_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [],
});
const server = serve({ fetch: api.fetch, hostname: environment.HOST, port: environment.PORT }, () => {
  console.log(`odot API listening on http://${environment.HOST}:${environment.PORT}`);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close(() => {
    void application.close().then(() => { clearTimeout(timeout); }, (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
  if ("closeIdleConnections" in server) server.closeIdleConnections();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
