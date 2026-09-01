/**
 * Example of building a ViteMCP server from an OpenAPI document.
 *
 * Demonstrates:
 * - Converting a document into one tool per operation
 * - Narrowing the operation set, which `fromOpenAPI` insists on for large documents
 * - Per-request credentials, resolved from `context.auth`
 * - Mixing generated tools with hand-written ones on the same server
 *
 * To run this example:
 * npx @vitemcp/server dev src/examples/openapi.ts
 */
import { fromOpenAPI } from "../openapi/index.js";
import { ViteMCP } from "../ViteMCP.js";

interface Session {
  [key: string]: unknown;
  upstreamToken: string;
}

const server = new ViteMCP<Session>({
  // Every request carries its own credentials: there is no session to hold a
  // token in, so the token has to come off the request.
  authenticate: async (request) => ({
    upstreamToken: request.headers.get("x-api-key") ?? "",
  }),
  name: "Petstore",
  version: "1.0.0",
});

server.addTool({
  annotations: { openWorldHint: false, readOnlyHint: true },
  description: "Report which upstream API this server is fronting",
  execute: async () => "Swagger Petstore v3",
  name: "describe-upstream",
});

await fromOpenAPI<Session>({
  // Resolved per request, so each caller's own key reaches the upstream API.
  headers: (context) => ({
    api_key: context.auth?.upstreamToken ?? "",
  }),

  // Without a selection, a document this size is refused rather than turned
  // into a tool list no client can present.
  include: (operation) => operation.tags.includes("pet"),

  server,

  spec: "https://petstore3.swagger.io/api/v3/openapi.json",
});

const transportType = process.argv.includes("--http-stream")
  ? "httpStream"
  : "stdio";

if (transportType === "httpStream") {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

  await server.start({ httpStream: { port }, transportType: "httpStream" });

  console.log(`Petstore MCP server is running at http://localhost:${port}/mcp`);
} else {
  await server.start({ transportType: "stdio" });
}
