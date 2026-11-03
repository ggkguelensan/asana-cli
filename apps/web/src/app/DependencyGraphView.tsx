import { DependencyDiagram } from '../components/DependencyDiagram';
import { useEffect } from 'react';
import { atom, useAtom } from 'jotai';
import { watchDependencyGraph, type DependencyGraph } from '@asana-cli/service-client';
const graphAtom=atom<DependencyGraph|null>(null);
const stateAtom=atom('Открываем граф…');
export function DependencyGraphView({root}:{root:string}){
 const [graph,setGraph]=useAtom(graphAtom);const [state,setState]=useAtom(stateAtom);
 useEffect(()=>watchDependencyGraph(root,{snapshot:setGraph,state:setState}),[root]);
 return <main className="app-shell dependency-view"><h1>Граф зависимостей</h1><p>{state}. Интерес этого view живёт до закрытия страницы; общий фоновый профиль продолжает работать.</p><a href="/">К моей работе</a>
  {graph&&<><p>Узлов: {graph.nodes.length} · ресурсов в lease: {graph.resources.length}</p>{graph.truncated&&<p>Показан ограниченный граф: до трёх уровней и 12 задач на уровень.</p>}
  <DependencyDiagram graph={graph}/><div className="dependency-nodes">{graph.nodes.map(node=><article className="dependency-node" key={node.id}><h2>{node.title}</h2><p>{node.completed?'Завершена':'Не завершена'}</p><a href={`https://app.asana.com/0/0/${node.id}`} target="_blank" rel="noopener noreferrer">Открыть в Asana</a>
   <ul>{graph.edges.filter(edge=>edge.from===node.id).map(edge=><li key={edge.to}>Зависит от: {graph.nodes.find(n=>n.id===edge.to)?.title??'Задача за пределами графа'}</li>)}</ul></article>)}</div></>}
 </main>;
}
