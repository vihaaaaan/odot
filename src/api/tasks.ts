import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { createTaskInput, listTasksInput, moveTaskInput, updateTaskInput } from "../tasks/inputs.js";
import { entityId } from "../shared/validation.js";
import {
  type ApiEnvironment, bearerSecurity, completionInput, errorResponses, idParams, jsonResponse,
  serializeTag, serializeTask, taskResponse, taskTagParams, taskWithTagsResponse,
} from "./contracts.js";

const integerQuery = z.string().regex(/^\d+$/).transform(Number);
const listQuery = listTasksInput.extend({
  tagIds: z.union([entityId, listTasksInput.shape.tagIds.unwrap()])
    .transform((value) => typeof value === "string" ? [value] : value).optional()
    .openapi({
      type: "array", items: { type: "string", format: "uuid" },
      param: { name: "tagIds", in: "query", style: "form", explode: true },
    }),
  important: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  limit: integerQuery.pipe(listTasksInput.shape.limit.unwrap()).optional(),
  offset: integerQuery.pipe(listTasksInput.shape.offset.unwrap()).optional(),
});

export function registerTaskRoutes(api: OpenAPIHono<ApiEnvironment>) {
  api.openapi(createRoute({
    method: "get", path: "/v1/tasks", operationId: "listTasks", tags: ["Tasks"], security: bearerSecurity,
    request: { query: listQuery },
    responses: { 200: jsonResponse(z.array(taskWithTagsResponse), "Tasks in the requested sort order"), ...errorResponses },
  }), async (context) => {
    const tasks = await context.get("todo").tasks.list(context.req.valid("query"));
    return context.json(tasks.map((task) => ({ ...serializeTask(task), tags: task.tags.map(serializeTag) })), 200);
  });

  api.openapi(createRoute({
    method: "post", path: "/v1/tasks", operationId: "createTask", tags: ["Tasks"], security: bearerSecurity,
    request: { body: { required: true, content: { "application/json": { schema: createTaskInput } } } },
    responses: { 201: jsonResponse(taskWithTagsResponse, "Created task"), ...errorResponses },
  }), async (context) => {
    const task = await context.get("todo").tasks.create(context.req.valid("json"));
    context.header("Location", `/v1/tasks/${task.id}`);
    return context.json({ ...serializeTask(task), tags: task.tags.map(serializeTag) }, 201);
  });

  api.openapi(createRoute({
    method: "get", path: "/v1/tasks/{id}", operationId: "getTask", tags: ["Tasks"], security: bearerSecurity,
    request: { params: idParams },
    responses: { 200: jsonResponse(taskWithTagsResponse, "Task and its tags"), ...errorResponses },
  }), async (context) => {
    const task = await context.get("todo").tasks.get(context.req.valid("param").id);
    return context.json({ ...serializeTask(task), tags: task.tags.map(serializeTag) }, 200);
  });

  api.openapi(createRoute({
    method: "patch", path: "/v1/tasks/{id}", operationId: "updateTask", tags: ["Tasks"], security: bearerSecurity,
    request: { params: idParams, body: { required: true, content: { "application/json": { schema: updateTaskInput } } } },
    responses: { 200: jsonResponse(taskResponse, "Updated task"), ...errorResponses },
  }), async (context) => context.json(serializeTask(await context.get("todo").tasks.update(
    context.req.valid("param").id, context.req.valid("json"),
  )), 200));

  api.openapi(createRoute({
    method: "put", path: "/v1/tasks/{id}/completion", operationId: "setTaskCompleted", tags: ["Tasks"], security: bearerSecurity,
    request: { params: idParams, body: { required: true, content: { "application/json": { schema: completionInput } } } },
    responses: { 200: jsonResponse(taskResponse, "Completed or reopened task; saved order is preserved"), ...errorResponses },
  }), async (context) => context.json(serializeTask(await context.get("todo").tasks.setCompleted(
    context.req.valid("param").id, context.req.valid("json").completed,
  )), 200));

  api.openapi(createRoute({
    method: "post", path: "/v1/tasks/{id}/move", operationId: "moveTask", tags: ["Tasks"], security: bearerSecurity,
    request: { params: idParams, body: { required: true, content: { "application/json": { schema: moveTaskInput } } } },
    responses: { 200: jsonResponse(taskResponse, "Task with its new saved order"), ...errorResponses },
  }), async (context) => context.json(serializeTask(await context.get("todo").tasks.move(
    context.req.valid("param").id, context.req.valid("json"),
  )), 200));

  api.openapi(createRoute({
    method: "delete", path: "/v1/tasks/{id}", operationId: "deleteTask", tags: ["Tasks"], security: bearerSecurity,
    request: { params: idParams }, responses: { 204: { description: "Task deleted" }, ...errorResponses },
  }), async (context) => {
    await context.get("todo").tasks.delete(context.req.valid("param").id);
    return context.body(null, 204);
  });

  api.openapi(createRoute({
    method: "put", path: "/v1/tasks/{id}/tags/{tagId}", operationId: "attachTaskTag", tags: ["Tasks"], security: bearerSecurity,
    request: { params: taskTagParams }, responses: { 204: { description: "Tag attached (idempotent)" }, ...errorResponses },
  }), async (context) => {
    const { id, tagId } = context.req.valid("param");
    await context.get("todo").tasks.attachTag(id, tagId);
    return context.body(null, 204);
  });

  api.openapi(createRoute({
    method: "delete", path: "/v1/tasks/{id}/tags/{tagId}", operationId: "detachTaskTag", tags: ["Tasks"], security: bearerSecurity,
    request: { params: taskTagParams }, responses: { 204: { description: "Tag detached" }, ...errorResponses },
  }), async (context) => {
    const { id, tagId } = context.req.valid("param");
    await context.get("todo").tasks.detachTag(id, tagId);
    return context.body(null, 204);
  });
}
