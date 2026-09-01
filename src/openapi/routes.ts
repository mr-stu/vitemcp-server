import type {
  HttpMethod,
  HttpRoute,
  OpenApiDocument,
  OpenApiParameter,
  OpenApiRef,
  OpenApiRequestBody,
  OpenApiResponse,
  OperationSummary,
} from "./types.js";

/**
 * `head`, `options` and `trace` are omitted on purpose: they answer questions
 * about a resource rather than doing anything with it, so a tool built from
 * one gives a model nothing it can act on.
 */
const HTTP_METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete"];

/** How many `$ref` hops to follow before assuming the document is cyclic. */
const MAX_REF_HOPS = 32;

/**
 * Flattens a document's `paths` into a list of routes, resolving the
 * structural (non-schema) `$ref`s on parameters, request bodies and responses
 * — `#/components/parameters/Limit` and the like.
 *
 * Every remaining `$ref` at this point is local (see `loadSpec`), so a plain
 * JSON Pointer lookup is enough. Schema `$ref`s are left alone: those are
 * handed to the client as part of the tool's input schema, where they are
 * resolved against `$defs` instead (see `schemas.ts`).
 */
export const extractRoutes = (document: OpenApiDocument): HttpRoute[] => {
  const routes: HttpRoute[] = [];

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object") {
      continue;
    }

    const pathLevelParameters = (pathItem.parameters ?? []).map((parameter) =>
      resolve<OpenApiParameter>(document, parameter),
    );

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];

      if (!operation) {
        continue;
      }

      const responses: Record<string, OpenApiResponse> = {};

      for (const [status, response] of Object.entries(
        operation.responses ?? {},
      )) {
        responses[status] = resolve<OpenApiResponse>(document, response) ?? {};
      }

      routes.push({
        deprecated: operation.deprecated ?? false,
        description: operation.description,
        method,
        operationId: operation.operationId,
        parameters: mergeParameters(
          pathLevelParameters,
          (operation.parameters ?? []).map((parameter) =>
            resolve<OpenApiParameter>(document, parameter),
          ),
        ),
        path,
        requestBody: operation.requestBody
          ? resolve<OpenApiRequestBody>(document, operation.requestBody)
          : undefined,
        responses,
        servers: operation.servers ?? pathItem.servers,
        summary: operation.summary,
        tags: operation.tags ?? [],
      });
    }
  }

  return routes;
};

export const toOperationSummary = (route: HttpRoute): OperationSummary => ({
  deprecated: route.deprecated,
  description: route.description,
  method: route.method,
  operationId: route.operationId,
  path: route.path,
  summary: route.summary,
  tags: route.tags,
});

/**
 * An operation-level parameter overrides a path-level one with the same
 * name *and* location, per the OpenAPI specification — the pair is the
 * identity, so a `limit` in the query does not shadow a `limit` in the path.
 */
const mergeParameters = (
  pathLevel: OpenApiParameter[],
  operationLevel: OpenApiParameter[],
): OpenApiParameter[] => {
  const overridden = new Set(
    operationLevel.map((parameter) => `${parameter.in}:${parameter.name}`),
  );

  return [
    ...pathLevel.filter(
      (parameter) => !overridden.has(`${parameter.in}:${parameter.name}`),
    ),
    ...operationLevel,
  ].filter((parameter) => parameter?.name && parameter.in);
};

const resolve = <TValue>(
  document: OpenApiDocument,
  value: OpenApiRef | TValue,
): TValue => {
  let node: unknown = value;

  for (let hop = 0; hop < MAX_REF_HOPS; hop++) {
    if (!node || typeof node !== "object" || !("$ref" in node)) {
      return node as TValue;
    }

    const pointer = (node as OpenApiRef).$ref;

    if (!pointer.startsWith("#")) {
      // Bundling turns every external ref into a local one; reaching here
      // means the bundler's output shape changed under us.
      throw new Error(`Unresolved external $ref after bundling: ${pointer}`);
    }

    node = readPointer(document, pointer);
  }

  throw new Error(
    `$ref chain longer than ${MAX_REF_HOPS} hops, which a cyclic document is the only way to produce.`,
  );
};

/**
 * Reads an RFC 6901 JSON Pointer written as a URI fragment, which is the form
 * the bundler emits — a path like `/pets/{petId}` becomes
 * `~1pets~1%7BpetId%7D`, so each segment needs percent-decoding *and* its
 * `~1`/`~0` escapes undone, in that order.
 */
const readPointer = (root: unknown, pointer: string): unknown => {
  const path = pointer.slice(1);

  if (path === "" || path === "/") {
    return root;
  }

  let node: unknown = root;

  for (const rawSegment of path.slice(1).split("/")) {
    const segment = decodeSegment(rawSegment);
    node = (node as Record<string, unknown> | undefined)?.[segment];
  }

  return node;
};

const decodeSegment = (segment: string): string => {
  let decoded = segment;

  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A segment that is not valid percent-encoding is used verbatim, which is
    // what a document that never encoded it in the first place intended.
  }

  return decoded.replaceAll("~1", "/").replaceAll("~0", "~");
};
