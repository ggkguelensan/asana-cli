import { expect, test } from 'bun:test';
import { taskSchema, selectedTask, InterestRegistry } from '../src';

test('current work is an explicit section rule, not any unfinished backlog or category',()=>{
 const task=(name:string)=>taskSchema.parse({gid:'1',memberships:[{project:{gid:'p'},section:{gid:'s',name}}]});
 const rule={preset:'current_work',choices:[]} as const;
 for(const name of ['In Progress','In progress','Code review','To Do']) expect(selectedTask(task(name),{...rule,choices:[]})).toBe(true);
 expect(selectedTask(task('Backlog'),{...rule,choices:[]})).toBe(false);
 expect(selectedTask({...task('In Progress'),completed:true},{...rule,choices:[]})).toBe(false);
 expect(selectedTask(task('Backlog'),{preset:'custom',choices:['section:s']})).toBe(true);
});
test('closing/expiring a view releases only its interest and does not remove the background owner',()=>{
 const registry=new InterestRegistry();
 registry.set('background',['a']); registry.set('graph',['a','b'],100);
 expect(registry.count('a')).toBe(2);
 registry.release('graph'); expect(registry.resources()).toEqual(['a']);
 registry.set('graph',['b'],100); registry.expire(100);
 expect(registry.resources()).toEqual(['a']);
});
