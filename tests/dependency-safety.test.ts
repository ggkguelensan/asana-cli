import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  assertDependencyAdditionAcyclic,
  assertDependencyAdditionWithinRelationLimits,
  DEPENDENCY_GRAPH_MAX_DEPTH,
  DEPENDENCY_GRAPH_MAX_VISITED_TASKS,
  MAX_COMBINED_DEPENDENCY_RELATIONS,
  readDirectDependencyGids,
} from "../src/dependency-safety";
import { createClient, type AsanaClient } from "../src/sdk";

const apiCallSchema = z.tuple([
  z.string(),
  z.string(),
  z.record(z.string(), z.string()),
  z.record(z.string(), z.unknown()),
  z.record(z.string(), z.unknown()),
  z.record(z.string(), z.unknown()),
  z.unknown(),
  z.array(z.string()),
  z.array(z.string()),
  z.array(z.string()),
  z.unknown(),
]);

function dependencyClient(
  graph: Readonly<Record<string, readonly string[]>>,
  status?: number,
  dependentGraph: Readonly<Record<string, readonly string[]>> = {},
): AsanaClient {
  const client = createClient(`DEPENDENCY_SAFETY_${Math.random().toString(16).slice(2)}`);
  Object.defineProperty(client, "callApi", {
    configurable: true,
    value: async (...rawArguments: unknown[]) => {
      const [path, method, pathParams] = apiCallSchema.parse(rawArguments);
      if (
        method !== "GET" ||
        (
          path !== "/tasks/{task_gid}/dependencies" &&
          path !== "/tasks/{task_gid}/dependents"
        )
      ) {
        throw new Error(`Unexpected fake Asana call: ${method} ${path}`);
      }
      if (status !== undefined) {
        throw { response: { status } };
      }
      return {
        response: {},
        data: {
          data: (
            path.endsWith("/dependencies")
              ? graph[pathParams.task_gid]
              : dependentGraph[pathParams.task_gid]
          ?? []).map((gid) => ({ gid })),
          next_page: null,
        },
      };
    },
  });
  return client;
}

describe("bounded dependency graph validation", () => {
  test("returns exact sorted direct relations and detects a cycle", async () => {
    const client = dependencyClient({
      "123": ["126", "124", "124"],
      "124": ["125"],
      "125": ["123"],
    });
    await expect(readDirectDependencyGids(client, "123")).resolves.toEqual([
      "124",
      "126",
    ]);
    await expect(assertDependencyAdditionAcyclic(client, "123", "124"))
      .rejects.toMatchObject({ code: "conflict" });
  });

  test("fails closed on premium restrictions and oversized direct relations", async () => {
    await expect(readDirectDependencyGids(dependencyClient({}, 402), "123"))
      .rejects.toMatchObject({ code: "ambiguous" });
    const oversized = Array.from({ length: 101 }, (_, index) => String(1_000 + index));
    await expect(readDirectDependencyGids(
      dependencyClient({ "123": oversized }),
      "123",
    )).rejects.toMatchObject({ code: "ambiguous" });
  });

  test("fails closed when depth or visited-task proof bounds are exceeded", async () => {
    const depthGraph: Record<string, string[]> = {};
    const first = 1_000;
    for (let index = 0; index <= DEPENDENCY_GRAPH_MAX_DEPTH; index += 1) {
      depthGraph[String(first + index)] = [String(first + index + 1)];
    }
    await expect(assertDependencyAdditionAcyclic(
      dependencyClient(depthGraph),
      "999",
      String(first),
    )).rejects.toMatchObject({ code: "ambiguous" });

    const broad = Array.from(
      { length: DEPENDENCY_GRAPH_MAX_VISITED_TASKS },
      (_, index) => String(2_000 + index),
    );
    await expect(assertDependencyAdditionAcyclic(
      dependencyClient({ "1999": broad }),
      "999",
      "1999",
    )).rejects.toMatchObject({ code: "ambiguous" });
  });

  test("rejects additions at Asana's combined dependency/dependent limit", async () => {
    const relations = Array.from(
      { length: MAX_COMBINED_DEPENDENCY_RELATIONS },
      (_, index) => String(3_000 + index),
    );
    await expect(assertDependencyAdditionWithinRelationLimits(
      dependencyClient({ "123": relations, "124": [] }),
      "123",
      "124",
    )).rejects.toMatchObject({ code: "conflict" });

    await expect(assertDependencyAdditionWithinRelationLimits(
      dependencyClient(
        { "123": [], "124": [] },
        undefined,
        { "124": relations },
      ),
      "123",
      "124",
    )).rejects.toMatchObject({ code: "conflict" });
  });
});
