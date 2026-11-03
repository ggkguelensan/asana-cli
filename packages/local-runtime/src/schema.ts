import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const settings = sqliteTable('settings', { key:text('key').primaryKey(), value:text('value').notNull() });
export const workItems = sqliteTable('work_items', {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull(),
  data: text('data').notNull(),
});
