import { z } from "zod";
import { CliError, errorStatus } from "./errors";
import { gidSchema } from "./schemas";
import {
  asCollection,
  collectPages,
  invokeApiMethod,
  type AsanaClient,
} from "./sdk";

export const DEPENDENCY_GRAPH_MAX_VISITED_TASKS = 64;
export const DEPENDENCY_GRAPH_MAX_DEPTH = 16;
export const MAX_COMBINED_DEPENDENCY_RELATIONS = 30;
const DEPENDENCY_GRAPH_READ_CONCURRENCY = 8;
const MAX_DIRECT_DEPENDENCIES = 100;

const dependencyResourceSchema = z.looseObject({
  gid: gidSchema,
});

async function readDirectRelationGids(
  client: AsanaClient,
  taskGidValue: unknown,
  method: "getDependenciesForTask" | "getDependentsForTask",
  context: "TasksApi.getDependenciesForTask" | "TasksApi.getDependentsForTask",
): Promise<string[]> {
  const taskGid = gidSchema.parse(taskGidValue);
  try {
    const collection = await invokeApiMethod(client, "TasksApi", method, [
      taskGid,
      { limit: MAX_DIRECT_DEPENDENCIES, opt_fields: "gid" },
    ]);
    const collected = await collectPages(
      asCollection(collection, context),
      true,
      MAX_DIRECT_DEPENDENCIES,
      dependencyResourceSchema,
      context,
      true,
    );
    if (
      collected.truncated ||
      (collected.next_page !== null && collected.next_page !== undefined)
    ) {
      throw new CliError(
        "ambiguous",
        "Dependency graph validation exceeded the direct-relation limit",
      );
    }
    return [...new Set(collected.data.map((dependency) => dependency.gid))].sort();
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (errorStatus(error) === 402) {
      throw new CliError(
        "ambiguous",
        "Dependency graph validation is unavailable for this Asana workspace",
      );
    }
    throw error;
  }
}

export function readDirectDependencyGids(
  client: AsanaClient,
  taskGidValue: unknown,
): Promise<string[]> {
  return readDirectRelationGids(
    client,
    taskGidValue,
    "getDependenciesForTask",
    "TasksApi.getDependenciesForTask",
  );
}

export function readDirectDependentGids(
  client: AsanaClient,
  taskGidValue: unknown,
): Promise<string[]> {
  return readDirectRelationGids(
    client,
    taskGidValue,
    "getDependentsForTask",
    "TasksApi.getDependentsForTask",
  );
}

export async function assertDependencyAdditionWithinRelationLimits(
  client: AsanaClient,
  taskGidValue: unknown,
  dependencyTaskGidValue: unknown,
): Promise<void> {
  const taskGid = gidSchema.parse(taskGidValue);
  const dependencyTaskGid = gidSchema.parse(dependencyTaskGidValue);
  const [
    taskDependencies,
    taskDependents,
    dependencyDependencies,
    dependencyDependents,
  ] = await Promise.all([
    readDirectDependencyGids(client, taskGid),
    readDirectDependentGids(client, taskGid),
    readDirectDependencyGids(client, dependencyTaskGid),
    readDirectDependentGids(client, dependencyTaskGid),
  ]);
  if (
    taskDependencies.length + taskDependents.length >= MAX_COMBINED_DEPENDENCY_RELATIONS ||
    dependencyDependencies.length + dependencyDependents.length >=
      MAX_COMBINED_DEPENDENCY_RELATIONS
  ) {
    throw new CliError(
      "conflict",
      "The dependency would exceed Asana's per-task relation limit",
    );
  }
}

async function readFrontier(
  client: AsanaClient,
  frontier: readonly string[],
): Promise<string[][]> {
  const dependencies: string[][] = [];
  for (let index = 0; index < frontier.length; index += DEPENDENCY_GRAPH_READ_CONCURRENCY) {
    dependencies.push(...await Promise.all(
      frontier
        .slice(index, index + DEPENDENCY_GRAPH_READ_CONCURRENCY)
        .map((taskGid) => readDirectDependencyGids(client, taskGid)),
    ));
  }
  return dependencies;
}

/**
 * Proves that adding dependencyTaskGid as a dependency of taskGid cannot close a
 * cycle within the bounded graph. An incomplete proof fails closed before prepare/apply.
 */
export async function assertDependencyAdditionAcyclic(
  client: AsanaClient,
  taskGidValue: unknown,
  dependencyTaskGidValue: unknown,
): Promise<void> {
  const taskGid = gidSchema.parse(taskGidValue);
  const dependencyTaskGid = gidSchema.parse(dependencyTaskGidValue);
  if (taskGid === dependencyTaskGid) {
    throw new CliError("conflict", "A task cannot depend on itself");
  }

  const visited = new Set<string>();
  let frontier = [dependencyTaskGid];
  for (let depth = 0; frontier.length > 0; depth += 1) {
    if (frontier.includes(taskGid)) {
      throw new CliError("conflict", "The dependency would create a cycle");
    }
    const unvisited = frontier.filter((gid) => !visited.has(gid));
    if (unvisited.length === 0) return;
    if (
      depth > DEPENDENCY_GRAPH_MAX_DEPTH ||
      visited.size + unvisited.length > DEPENDENCY_GRAPH_MAX_VISITED_TASKS
    ) {
      throw new CliError(
        "ambiguous",
        "Dependency graph validation exceeded its bounded traversal",
      );
    }
    for (const gid of unvisited) visited.add(gid);
    const next = (await readFrontier(client, unvisited))
      .flat()
      .filter((gid) => !visited.has(gid));
    frontier = [...new Set(next)].sort();
  }
}
