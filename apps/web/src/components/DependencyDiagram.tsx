import type { DependencyGraph } from '@asana-cli/service-client';
interface Point {x:number;y:number}
function positions(graph:DependencyGraph){
 const depth=new Map<string,number>([[graph.root,0]]);
 function extend(edge:{from:string;to:string}){const parent=depth.get(edge.from);if(parent===undefined)return;if(!depth.has(edge.to))depth.set(edge.to,parent+1);}
 for(let round=0;round<3;round++)graph.edges.forEach(extend);
 const counts=new Map<number,number>();const points=new Map<string,Point>();
 function place(node:DependencyGraph['nodes'][number]){const level=depth.get(node.id)??0;const row=counts.get(level)??0;counts.set(level,row+1);points.set(node.id,{x:20+level*310,y:20+row*110});}
 graph.nodes.forEach(place);
 return {points,width:Math.max(340,...[...points.values()].map(p=>p.x+290)),height:Math.max(130,...[...points.values()].map(p=>p.y+100))};
}
function Edge({from,to}:{from:Point;to:Point}){return <path d={`M${from.x+135},${from.y+72} C${from.x+135},${from.y+100} ${to.x+135},${to.y-28} ${to.x+135},${to.y}`} fill="none" stroke="currentColor" opacity="0.45" markerEnd="url(#dependency-arrow)"/>;}
export function DependencyDiagram({graph}:{graph:DependencyGraph}){
 const layout=positions(graph);
 return <div className="dependency-diagram"><svg width={layout.width} height={layout.height} role="img" aria-label="Граф: стрелка ведёт от задачи к её зависимости"><defs><marker id="dependency-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="currentColor"/></marker></defs>
  {graph.edges.map(edge=>{const from=layout.points.get(edge.from);const to=layout.points.get(edge.to);return from&&to?<Edge key={`${edge.from}-${edge.to}`} from={from} to={to}/>:null;})}
  {graph.nodes.map(node=>{const point=layout.points.get(node.id)!;return <g key={node.id} transform={`translate(${point.x},${point.y})`}><title>{node.title}</title><rect width="270" height="72" rx="12" fill={node.completed?'#e9f4e9':'#f2f4f8'} stroke="#a5adbb"/><text x="12" y="25" fill="#192336" fontSize="13">{node.title.slice(0,36)}</text><text x="12" y="48" fill="#59667a" fontSize="12">{node.completed?'Завершена':'Зависимости →'}</text></g>;})}
 </svg></div>;
}
