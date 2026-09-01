import type { ToolAnnotations } from "@modelcontextprotocol/server";

import type { ViteMCPAuth } from "../ViteMCP.js";
import type { FromOpenAPIOptions, HttpMethod, HttpRoute } from "./types.js";

import { jsonSchemaAdapter } from "../jsonSchemaAdapter.js";
import { ViteMCP } from "../ViteMCP.js";
import { executeRequest, resolveBaseUrl } from "./executeRequest.js";
import { loadSpec } from "./loadSpec.js";
import { generateToolNames } from "./naming.js";
import { createSchemaNormalizer } from "./normalize.js";
import { extractRoutes } from "./routes.js";
import { buildToolBinding } from "./schemas.js";
import { selectRoutes } from "./selection.js";

/**
 * How each HTTP method is described to a client, so the annotations say
 * something the model can act on rather than repeating the default.
 *
 * `openWorldHint` is true throughout: every one of these tools calls somebody
 * else's API.
 */
const ANNOTATIONS: Record<HttpMethod, ToolAnnotations> = {
  delete: { destructiveHint: true, idempotentHint: true, readOnlyHint: false },
  get: { idempotentHint: true, readOnlyHint: true },
  patch: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
  post: { destructiveHint: false, idempotentHint: false, readOnlyHint: false },
  put: { destructiveHint: true, idempotentHint: true, readOnlyHint: false },
};

const DEFAULT_MAX_RESPONSE_CHARACTERS = 1_000_000;

/**
 * Turns an OpenAPI 3.x document into an MCP server, one tool per operation.
 *
 * ```ts
 * const server = await fromOpenAPI({
 *   headers: (context) => ({ authorization: `Bearer ${context.auth?.token}` }),
 *   include: (operation) => operation.tags.includes("pet"),
 *   spec: "https://petstore3.swagger.io/api/v3/openapi.json",
 * });
 * ```
 *
 * See `docs/openapi.md` for the option reference and the known limits.
 */
export const fromOpenAPI = async <T extends ViteMCPAuth = ViteMCPAuth>(
  options: FromOpenAPIOptions<T>,
): Promise<ViteMCP<T>> => {
  const { document, origin } = await loadSpec(options.spec);
  const selected = selectRoutes(extractRoutes(document), options);
  const names = generateToolNames(selected, options.toolNames);
  const normalizer = createSchemaNormalizer(document);

  const server =
    options.server ??
    new ViteMCP<T>({
      description: document.info?.description,
      name: options.name ?? document.info?.title ?? "OpenAPI",
      version: options.version ?? semanticVersion(document.info?.version),
    });

  for (const route of selected) {
    const name = names.get(route);

    if (!name) {
      continue;
    }

    const binding = buildToolBinding(
      route,
      normalizer,
      options.outputSchema ?? false,
    );

    // Resolved once, at build time: an unusable `servers` entry should fail
    // while the server is being built, not on the first call of one tool.
    const baseUrl = resolveBaseUrl(
      route.servers ?? document.servers,
      origin,
      options.baseUrl,
    );

    server.addTool({
      annotations: {
        ...ANNOTATIONS[route.method],
        openWorldHint: true,
        ...(route.summary ? { title: route.summary } : {}),
      },
      description: describe(route, binding.caveat),
      execute: (args, context) =>
        executeRequest({
          args: args as Record<string, unknown>,
          baseUrl,
          binding,
          context,
          fetchImpl: options.fetch ?? globalThis.fetch,
          headers: options.headers,
          maxResponseCharacters:
            options.maxResponseCharacters ?? DEFAULT_MAX_RESPONSE_CHARACTERS,
          query: options.query,
          route,
        }),
      name,
      outputSchema: binding.outputSchema
        ? jsonSchemaAdapter(binding.outputSchema)
        : undefined,
      parameters: jsonSchemaAdapter(binding.inputSchema),
      timeoutMs: options.timeoutMs,
    });
  }

  return server;
};

/**
 * The description a model reads before choosing this tool. Both `summary` and
 * `description` are kept — the first is the one-line "what", the second the
 * caveats — and the method and path are appended because two operations on
 * neighbouring paths often share a summary word for word.
 */
const describe = (route: HttpRoute, caveat: string | undefined): string =>
  [
    route.deprecated ? "Deprecated." : undefined,
    route.summary,
    route.description !== route.summary ? route.description : undefined,
    caveat,
    `${route.method.toUpperCase()} ${route.path}`,
  ]
    .filter(Boolean)
    .join("\n\n");

/**
 * The document's own `info.version`, when it is one ViteMCP's server metadata
 * can carry. OpenAPI puts no constraint on the field, so documents version
 * themselves with dates and release names too.
 */
const semanticVersion = (
  version: string | undefined,
): `${number}.${number}.${number}` =>
  version && /^\d+\.\d+\.\d+$/.test(version)
    ? (version as `${number}.${number}.${number}`)
    : "1.0.0";
