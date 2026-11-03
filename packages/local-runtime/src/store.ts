/// <reference path="./asset-types.d.ts" />
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { eq } from 'drizzle-orm';
import { mkdirSync, chmodSync, existsSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { workRepository } from './work-repository';
import { settings } from './schema';
import workflowMigration from '../drizzle/0001_spooky_landau.sql' with { type:'text' };
import migration from '../drizzle/0000_majestic_pandemic.sql' with { type:'text' };
import { trackingRuleSchema, type TrackingRule } from '@asana-cli/core';

function prepareFile(directory:string){
  mkdirSync(directory,{recursive:true,mode:0o700});assertRegular(directory);chmodSync(directory,0o700);
  const path=join(directory,'state.sqlite');
  if(!existsSync(path))writeFileSync(path,'',{mode:0o600,flag:'wx'});
  assertRegular(path);chmodSync(path,0o600);return path;
}
function assertRegular(path:string){if(lstatSync(path).isSymbolicLink())throw new Error('Invalid service path');}
function migrate(sqlite:Database){
  const version=sqlite.query<{user_version:number},[]>('PRAGMA user_version').get()!.user_version;
  if(version>2)throw new Error('Database is newer than this binary');
  sqlite.transaction(()=>{
    if(version===0)sqlite.exec(migration);
    if(version<2)sqlite.exec(workflowMigration);
    sqlite.exec('PRAGMA user_version = 2');
  })();
}
export function openStore(directory:string){
  const sqlite=new Database(prepareFile(directory));migrate(sqlite);
  sqlite.exec('PRAGMA journal_mode = WAL');
  const db=drizzle(sqlite);
  const read=(key:string)=>db.select().from(settings).where(eq(settings.key,key)).get()?.value;
  const write=(key:string,value:string)=>db.insert(settings).values({key,value}).onConflictDoUpdate({target:settings.key,set:{value}}).run();
  return {
    work: workRepository(db),
    rule:()=>trackingRuleSchema.parse(JSON.parse(read('tracking_rule')??'{}') as unknown),
    saveRule:(rule:TrackingRule)=>write('tracking_rule',JSON.stringify(rule)),
    bindAccount(gid:string){const old=read('account');if(old&&old!==gid)throw new Error('Account mismatch: use a separate profile');write('account',gid);},
    stop:()=>write('stopped_by_user','true'),
    close:()=>sqlite.close(),
  };
}
