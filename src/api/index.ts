import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import { AuthenticationError, ConflictError, NotFoundError } from "../shared/errors.js";
import type { ApiEnvironment, Application } from "./contracts.js";
import { registerTagRoutes } from "./tags.js";
import { registerTaskRoutes } from "./tasks.js";

function validationFailure(error: ZodError) {
  return { error: {
    code: "VALIDATION_ERROR", message: "Invalid request",
    details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  } };
}

export function createApi(application: Pick<Application, "forToken">, options: {
  allowedOrigins?: string[];
  onUnexpectedError?: (error: Error) => void;
} = {}) {
  const api = new OpenAPIHono<ApiEnvironment>({
    defaultHook: (result, context) => {
      if (!result.success) return context.json(validationFailure(result.error), 400);
    },
  });

  api.use("*", secureHeaders());
  api.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    try {
      await next();
    } catch (error) {
      if (error instanceof ZodError) return context.json(validationFailure(error), 400);
      throw error instanceof Error ? error : new Error("Unexpected non-Error rejection", { cause: error });
    }
  });
  if (options.allowedOrigins?.length) {
    if (options.allowedOrigins.some((origin) => origin === "*" || origin === "null")) {
      throw new Error("Configure explicit allowed origins, not wildcard or null origins");
    }
    api.use("/v1/*", cors({
      origin: options.allowedOrigins,
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      exposeHeaders: ["Location"],
      maxAge: 600,
    }));
  }
  api.use("/v1/*", async (context, next) => {
    const authorization = context.req.header("Authorization");
    const token = authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    if (!token) throw new AuthenticationError();
    context.set("todo", await application.forToken(token));
    await next();
  });
  api.use("/v1/*", bodyLimit({
    maxSize: 256 * 1024,
    onError: (context) => context.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 256 KiB" } }, 413),
  }));
  api.onError((error, context) => {
    if (error instanceof AuthenticationError) {
      context.header("WWW-Authenticate", "Bearer");
      return context.json({ error: { code: error.code, message: error.message } }, 401);
    }
    if (error instanceof ZodError) {
      return context.json(validationFailure(error), 400);
    }
    if (error instanceof NotFoundError) return context.json({ error: { code: error.code, message: error.message } }, 404);
    if (error instanceof ConflictError) return context.json({ error: { code: error.code, message: error.message } }, 409);
    if (error instanceof HTTPException && error.status === 400) {
      return context.json({ error: { code: "BAD_REQUEST", message: "Malformed request body" } }, 400);
    }
    if (error instanceof HTTPException && error.status === 415) {
      return context.json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Expected application/json" } }, 415);
    }
    (options.onUnexpectedError ?? console.error)(error);
    return context.json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } }, 500);
  });
  api.notFound((context) => context.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404));

  api.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http", scheme: "bearer", bearerFormat: "JWT",
    description: "Neon Auth access token, not a Google access token or a user ID",
  });
  registerTaskRoutes(api);
  registerTagRoutes(api);
  api.doc31("/openapi.json", {
    openapi: "3.1.0", info: { title: "odot API", version: "1.0.0" },
  });
  api.get("/health", (context) => context.json({ status: "ok" }));
  return api;
}
