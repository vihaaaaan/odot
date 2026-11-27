import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { createTagInput, updateTagInput } from "../tags/inputs.js";
import {
  type ApiEnvironment, bearerSecurity, errorResponses, idParams, jsonResponse, serializeTag, tagResponse,
} from "./contracts.js";

export function registerTagRoutes(api: OpenAPIHono<ApiEnvironment>) {
  api.openapi(createRoute({
    method: "get", path: "/v1/tags", operationId: "listTags", tags: ["Tags"], security: bearerSecurity,
    responses: { 200: jsonResponse(z.array(tagResponse), "User's tags"), ...errorResponses },
  }), async (context) => context.json((await context.get("todo").tags.list()).map(serializeTag), 200));

  api.openapi(createRoute({
    method: "post", path: "/v1/tags", operationId: "createTag", tags: ["Tags"], security: bearerSecurity,
    request: { body: { required: true, content: { "application/json": { schema: createTagInput } } } },
    responses: { 201: jsonResponse(tagResponse, "Created tag"), ...errorResponses },
  }), async (context) => {
    const tag = await context.get("todo").tags.create(context.req.valid("json"));
    context.header("Location", `/v1/tags/${tag.id}`);
    return context.json(serializeTag(tag), 201);
  });

  api.openapi(createRoute({
    method: "get", path: "/v1/tags/{id}", operationId: "getTag", tags: ["Tags"], security: bearerSecurity,
    request: { params: idParams }, responses: { 200: jsonResponse(tagResponse, "Tag"), ...errorResponses },
  }), async (context) => context.json(serializeTag(await context.get("todo").tags.get(context.req.valid("param").id)), 200));

  api.openapi(createRoute({
    method: "patch", path: "/v1/tags/{id}", operationId: "updateTag", tags: ["Tags"], security: bearerSecurity,
    request: { params: idParams, body: { required: true, content: { "application/json": { schema: updateTagInput } } } },
    responses: { 200: jsonResponse(tagResponse, "Updated tag"), ...errorResponses },
  }), async (context) => context.json(serializeTag(await context.get("todo").tags.update(
    context.req.valid("param").id, context.req.valid("json"),
  )), 200));

  api.openapi(createRoute({
    method: "delete", path: "/v1/tags/{id}", operationId: "deleteTag", tags: ["Tags"], security: bearerSecurity,
    request: { params: idParams }, responses: { 204: { description: "Tag and its task assignments deleted" }, ...errorResponses },
  }), async (context) => {
    await context.get("todo").tags.delete(context.req.valid("param").id);
    return context.body(null, 204);
  });
}
