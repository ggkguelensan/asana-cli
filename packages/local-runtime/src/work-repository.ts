import { and, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { z } from 'zod';
import { workSchema, WorkflowError } from '@asana-cli/core/workflow';
import { workItems } from './schema';

const storedWorkSchema = workSchema.extend({ input_hash: z.string(), lease_hash: z.string().optional() });
export type StoredWork = z.infer<typeof storedWorkSchema>;
export function workRepository(db: BunSQLiteDatabase) {
  function decode(value: string) { return storedWorkSchema.parse(JSON.parse(value) as unknown); }
  return {
    get(id: string) { const row = db.select().from(workItems).where(eq(workItems.id, id)).get(); return row && decode(row.data); },
    list() { return db.select().from(workItems).all().map(row => decode(row.data)); },
    insert(work: StoredWork) { db.insert(workItems).values({ id: work.id, revision: work.revision, data: JSON.stringify(work) }).run(); },
    replace(work: StoredWork, previous: number) {
      const result = db.update(workItems).set({ revision: work.revision, data: JSON.stringify(work) })
        .where(and(eq(workItems.id, work.id), eq(workItems.revision, previous))).returning({ id: workItems.id }).all();
      if (result.length !== 1) throw new WorkflowError('revision_conflict');
    },
  };
}
export type WorkRepository = ReturnType<typeof workRepository>;
