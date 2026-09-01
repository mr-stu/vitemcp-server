import { describe, expect, it } from "vitest";

import type { HttpMethod, HttpRoute } from "./types.js";

import { DEFAULT_MAX_TOOLS, selectRoutes } from "./selection.js";

const route = (
  method: HttpMethod,
  path: string,
  overrides: Partial<HttpRoute> = {},
): HttpRoute => ({
  deprecated: false,
  method,
  parameters: [],
  path,
  responses: {},
  tags: [],
  ...overrides,
});

const labels = (routes: HttpRoute[]): string[] =>
  routes.map((entry) => `${entry.method} ${entry.path}`);

describe("operation selection", () => {
  it("drops deprecated operations by default", () => {
    const routes = [
      route("get", "/pets"),
      route("get", "/legacy", { deprecated: true }),
    ];

    expect(labels(selectRoutes(routes, {}))).toEqual(["get /pets"]);
  });

  it("lets include ask for a deprecated operation back", () => {
    const routes = [route("get", "/legacy", { deprecated: true })];

    expect(
      labels(
        selectRoutes(routes, { include: (operation) => operation.deprecated }),
      ),
    ).toEqual(["get /legacy"]);
  });

  it("applies exclude after include", () => {
    const routes = [
      route("get", "/pets", { tags: ["pet"] }),
      route("delete", "/pets/{id}", { operationId: "nuke", tags: ["pet"] }),
      route("get", "/store", { tags: ["store"] }),
    ];

    expect(
      labels(
        selectRoutes(routes, {
          exclude: (operation) => operation.operationId === "nuke",
          include: (operation) => operation.tags.includes("pet"),
        }),
      ),
    ).toEqual(["get /pets"]);
  });

  it("orders reads first, then by path", () => {
    const routes = [
      route("delete", "/pets/{id}"),
      route("post", "/pets"),
      route("get", "/zoos"),
      route("get", "/pets"),
    ];

    expect(labels(selectRoutes(routes, {}))).toEqual([
      "get /pets",
      "get /zoos",
      "post /pets",
      "delete /pets/{id}",
    ]);
  });

  it("stops rather than emitting a tool list nothing can use", () => {
    const routes = Array.from({ length: DEFAULT_MAX_TOOLS + 1 }, (_, index) =>
      route("get", `/resource-${index}`),
    );

    expect(() => selectRoutes(routes, {})).toThrowError(
      /over the limit of 40 that applies when no selection is given/,
    );
  });

  it("does not apply the default limit once a selection is given", () => {
    const routes = Array.from({ length: DEFAULT_MAX_TOOLS + 1 }, (_, index) =>
      route("get", `/resource-${index}`),
    );

    expect(selectRoutes(routes, { include: () => true })).toHaveLength(
      DEFAULT_MAX_TOOLS + 1,
    );
  });

  it("throws on an explicit maxTools rather than truncating", () => {
    const routes = [route("get", "/a"), route("get", "/b")];

    expect(() => selectRoutes(routes, { maxTools: 1 })).toThrowError(
      /over the limit of 1\. Narrow the selection/,
    );
  });
});
