import { describe, expect, it } from "vitest";

import type { OpenApiDocument } from "./types.js";

import { collectDefinitions, createSchemaNormalizer } from "./normalize.js";

const documentWith = (
  schemas: Record<string, Record<string, unknown>>,
): OpenApiDocument => ({
  components: { schemas },
  openapi: "3.0.3",
});

describe("$ref hoisting", () => {
  it("moves a component schema into $defs and points at it", () => {
    const normalizer = createSchemaNormalizer(
      documentWith({
        Pet: { properties: { id: { type: "integer" } }, type: "object" },
      }),
    );

    expect(normalizer.normalize({ $ref: "#/components/schemas/Pet" })).toEqual({
      $ref: "#/$defs/Pet",
    });

    expect(normalizer.definitions.Pet).toEqual({
      properties: { id: { type: "integer" } },
      type: "object",
    });
  });

  it("renames a component whose name would need escaping in a pointer", () => {
    const normalizer = createSchemaNormalizer(
      documentWith({ "Pet / Owner": { type: "object" } }),
    );

    const schema = normalizer.normalize({
      $ref: "#/components/schemas/Pet%20%2F%20Owner",
    });

    expect(schema).toEqual({ $ref: "#/$defs/Pet_Owner" });
    expect(normalizer.definitions.Pet_Owner).toEqual({ type: "object" });
  });

  it("hoists a pointer to anywhere in the document, not just components", () => {
    // The shape a bundler produces when it collapses a repeated inline schema:
    // the second occurrence becomes a pointer at the first.
    const document: OpenApiDocument = {
      openapi: "3.0.3",
      paths: {
        "/pets": {
          get: {
            responses: {
              "200": {
                content: { "application/json": { schema: { type: "object" } } },
              },
            },
          },
        },
      },
    };

    const normalizer = createSchemaNormalizer(document);
    const schema = normalizer.normalize({
      $ref: "#/paths/~1pets/get/responses/200/content/application~1json/schema",
    });

    expect(schema).toEqual({ $ref: "#/$defs/schema" });
    expect(normalizer.definitions.schema).toEqual({ type: "object" });
  });

  it("drops a ref that points at nothing rather than emitting one AJV cannot compile", () => {
    const normalizer = createSchemaNormalizer(documentWith({}));

    expect(
      normalizer.normalize({
        $ref: "#/components/schemas/Missing",
        description: "kept",
      }),
    ).toEqual({ description: "kept" });
  });

  it("terminates on a self-referential schema", () => {
    const normalizer = createSchemaNormalizer(
      documentWith({
        Node: {
          properties: { child: { $ref: "#/components/schemas/Node" } },
          type: "object",
        },
      }),
    );

    expect(normalizer.normalize({ $ref: "#/components/schemas/Node" })).toEqual(
      {
        $ref: "#/$defs/Node",
      },
    );

    expect(normalizer.definitions.Node).toEqual({
      properties: { child: { $ref: "#/$defs/Node" } },
      type: "object",
    });
  });
});

describe("OpenAPI keywords that JSON Schema does not have", () => {
  const normalize = (schema: Record<string, unknown>) =>
    createSchemaNormalizer(documentWith({})).normalize(schema);

  it("folds nullable into the type it widens", () => {
    expect(normalize({ nullable: true, type: "string" })).toEqual({
      type: ["string", "null"],
    });

    expect(normalize({ nullable: true, type: ["string"] })).toEqual({
      type: ["string", "null"],
    });
  });

  it("drops a nullable that has no type to widen", () => {
    // AJV rejects this outright: '"nullable" cannot be used without "type"'.
    expect(normalize({ nullable: true, oneOf: [{ type: "string" }] })).toEqual({
      oneOf: [{ type: "string" }],
    });
  });

  it("drops nullable: false without disturbing the type", () => {
    expect(normalize({ nullable: false, type: "string" })).toEqual({
      type: "string",
    });
  });

  it("turns a draft-04 boolean exclusive bound into the value it qualified", () => {
    expect(normalize({ exclusiveMinimum: true, minimum: 0 })).toEqual({
      exclusiveMinimum: 0,
    });

    expect(normalize({ exclusiveMaximum: false, maximum: 10 })).toEqual({
      maximum: 10,
    });
  });

  it("drops a required flag that belongs on the parent as a list", () => {
    expect(normalize({ required: true, type: "string" })).toEqual({
      type: "string",
    });

    expect(normalize({ required: ["a"], type: "object" })).toEqual({
      required: ["a"],
      type: "object",
    });
  });

  it("leaves a property that happens to be named after a keyword alone", () => {
    expect(
      normalize({
        properties: {
          nullable: { type: "boolean" },
          required: { type: "string" },
        },
        type: "object",
      }),
    ).toEqual({
      properties: {
        nullable: { type: "boolean" },
        required: { type: "string" },
      },
      type: "object",
    });
  });

  it("does not rewrite a $ref-shaped key inside example data", () => {
    const normalizer = createSchemaNormalizer(
      documentWith({ Pet: { type: "object" } }),
    );

    expect(
      normalizer.normalize({
        example: { $ref: "#/components/schemas/Pet" },
        type: "object",
      }),
    ).toEqual({
      example: { $ref: "#/components/schemas/Pet" },
      type: "object",
    });
  });
});

describe("collectDefinitions", () => {
  const definitions = {
    Owner: { properties: { pet: { $ref: "#/$defs/Pet" } }, type: "object" },
    Pet: { type: "object" },
    Unused: { type: "object" },
  };

  it("follows references transitively and leaves the rest behind", () => {
    expect(
      collectDefinitions({ owner: { $ref: "#/$defs/Owner" } }, definitions),
    ).toEqual({ Owner: definitions.Owner, Pet: definitions.Pet });
  });

  it("returns undefined when nothing is referenced", () => {
    expect(collectDefinitions({ type: "string" }, definitions)).toBeUndefined();
  });
});
