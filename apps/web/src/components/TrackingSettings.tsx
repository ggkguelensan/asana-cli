function toggleChoice(choices:string[],id:string){return choices.includes(id)?choices.filter(v=>v!==id):[...choices,id];}
import { useEffect } from 'react';
import { atom, useAtom } from 'jotai';
import { loadTracking, saveTracking, type TrackingStatus } from '@asana-cli/service-client';
import type { TrackingRule } from '@asana-cli/core';

const statusAtom=atom<TrackingStatus|null>(null);
const errorAtom=atom('');
const busyAtom=atom(false);
const draftAtom=atom<TrackingRule|null>(null);
export function TrackingSettings(){
 const [status,setStatus]=useAtom(statusAtom);const [error,setError]=useAtom(errorAtom);const [busy,setBusy]=useAtom(busyAtom);const [draft,setDraft]=useAtom(draftAtom);
 useEffect(()=>{const abort=new AbortController();const load=()=>void loadTracking(abort.signal).then(setStatus).catch(()=>{});load();const timer=setInterval(load,5000);return()=>{abort.abort();clearInterval(timer);};},[]);
 async function save(rule:TrackingRule){if(!status)return;setDraft(rule);setBusy(true);setError('');try{await saveTracking(rule,status.csrf_token);setStatus(await loadTracking());}catch{setError('Не удалось сохранить выбор. Повторите подключение к сервису.');}finally{setDraft(null);setBusy(false);}}
 if(!status)return null;
 const rule=draft??status.rule;
 const groups=[...new Set(status.choices.map(c=>c.group))];
 const toggle=(id:string)=>void save({preset:'custom',choices:toggleChoice(rule.choices,id)});
 return <section className="tracking-settings"><h2>Моя текущая работа</h2><p>Назначенные мне незавершённые задачи. Выберите рабочие стадии — сервис найдёт задачи сам.</p>
  <div className="filter-group" aria-label="Что отслеживать">{([['current_work','To Do · In Progress · Code review'],['all_incomplete','Все незавершённые'],['custom','Мой набор стадий']] as const).map(([preset,label])=><button className="filter-button" key={preset} disabled={busy} aria-pressed={rule.preset===preset} onClick={()=>void save({preset,choices:rule.choices})}>{label}</button>)}</div>
  <p role="status">Найдено {status.candidates} · в выбранной работе {status.tracked} · ресурсов с интересом {status.subscriptions.resources} · Events API синхронизировано {status.subscriptions.synced} · ответов {status.subscriptions.event_responses}</p>
  <TrackingHealth status={status}/>
  {error&&<p role="alert">{error}</p>}
  <details><summary>Настроить реальные секции и поля Asana</summary><p>Для «Моего набора» достаточно совпадения с любым отмеченным признаком. Значения берутся из ваших задач, а не из предположений агента.</p>
   {groups.map(group=><fieldset key={group} disabled={busy}><legend>{group}</legend>{status.choices.filter(c=>c.group===group).map(choice=><label className="tracking-choice" key={choice.id}><input type="checkbox" checked={rule.choices.includes(choice.id)} onChange={()=>toggle(choice.id)}/>{choice.label} <small>({choice.count})</small></label>)}</fieldset>)}
  </details>
 </section>;
}

function TrackingHealth({status}:{status:TrackingStatus}){return <>
  {status.tracked>100&&<p>На доске первые 100 задач. Все выбранные задачи остаются в отслеживании.</p>}
  {status.truncated&&<p>Достигнут лимит discovery — показан ограниченный набор.</p>}
  {status.state!=='connected'&&<p>Asana недоступна. Показаны последние полученные данные.</p>}
</>;}
