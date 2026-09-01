import type { FromOpenAPIOptions, HttpMethod, HttpRoute } from "./types.js";

import { toOperationSummary } from "./routes.js";

/**
 * The ceiling that applies when a caller gave no `include`, `exclude` or
 * `maxTools` at all. Past this, conversion stops and says so.
 */
export const DEFAULT_MAX_TOOLS = 40;

/**
 * Read-first ordering. Combined with the throw on exceeding a limit it makes
 * the tool list stable across runs, so a document that gains an operation does
 * not reshuffle every name a client has already seen.
 */
const METHOD_ORDER: Record<HttpMethod, number> = {
  delete: 4,
  get: 0,
  patch: 3,
  post: 1,
  put: 2,
};

/**
 * Narrows the document's operations to the ones that become tools.
 *
 * Deprecated operations are dropped unless `include` asks for them back:
 * a document marks an operation deprecated to steer callers away from it, and
 * a model reading a tool list has no other way to know.
 *
 * Exceeding a limit throws rather than truncating. Silently dropping
 * operations the caller asked for is the failure this option exists to
 * prevent, and a tool list that quietly changes length as a document grows is
 * worse than one that stops and asks.
 */
export const selectRoutes = (
  routes: HttpRoute[],
  options: Pick<FromOpenAPIOptions, "exclude" | "include" | "maxTools">,
): HttpRoute[] => {
  const { exclude, include, maxTools } = options;

  let selected = include
    ? routes.filter((route) => include(toOperationSummary(route)))
    : routes.filter((route) => !route.deprecated);

  if (exclude) {
    selected = selected.filter((route) => !exclude(toOperationSummary(route)));
  }

  selected.sort(
    (a, b) =>
      METHOD_ORDER[a.method] - METHOD_ORDER[b.method] ||
      a.path.localeCompare(b.path),
  );

  const limit =
    maxTools ?? (include || exclude ? undefined : DEFAULT_MAX_TOOLS);

  if (limit !== undefined && selected.length > limit) {
    throw new Error(
      `fromOpenAPI selected ${selected.length} operations, over the limit of ${limit}` +
        (maxTools === undefined
          ? " that applies when no selection is given. Turning a large document into a tool per operation produces a list most clients cannot work with, so this stops rather than guessing. Pass `include`/`exclude` to choose the operations you want, or `maxTools` to raise the limit deliberately."
          : ". Narrow the selection with `include`/`exclude`, or raise `maxTools`."),
    );
  }

  return selected;
};
