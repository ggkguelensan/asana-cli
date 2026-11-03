import { Hono } from 'hono';
import { z } from 'zod';
import { createWorkSchema, workActionSchema, workSchema, WorkflowError } from '@asana-cli/core/workflow';
import type { Workflow } from './workflow';
import type { TaskSource } from './source';

export function workRoutes(workflow: Workflow, source: TaskSource) {
  const routes = new Hono();
  routes.onError((error, c) => {
    if (error instanceof WorkflowError) return c.json({ error: error.code }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: 'invalid_work_input' }, 422);
    return c.json({ error: 'source_unavailable' }, 503);
  });
  routes.get('/', c => c.json(workflow.list()));
  routes.post('/', async c => {
    const input = createWorkSchema.parse(await c.req.json());
    const existing = workflow.existing(input);
    if (existing) return c.json(workSchema.parse(existing));
    const task = await source.task(input.task_gid);
    return c.json(workSchema.parse(workflow.create(input, task, new Date().toISOString())), 201);
  });
  routes.post('/:id/actions', async c => {
    const id = z.uuid().parse(c.req.param('id'));
    const action = workActionSchema.parse(await c.req.json());
    if (action.kind !== 'claim') return c.json(workSchema.parse(workflow.act(id, action, new Date().toISOString())));
    const task = await source.task(workflow.get(id).task_gid);
    return c.json(workSchema.parse(workflow.claim(id, action, task, new Date().toISOString())));
  });
  return routes;
}
