export class AuthenticationError extends Error {
  readonly code = "UNAUTHENTICATED";

  constructor() {
    super("A valid Neon Auth access token is required");
    this.name = "AuthenticationError";
  }
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";

  constructor(entity: "Task" | "Tag", id: string) {
    super(`${entity} ${id} was not found`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  readonly code = "CONFLICT";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConflictError";
  }
}
