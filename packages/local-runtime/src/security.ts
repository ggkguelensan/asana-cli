import { timingSafeEqual } from 'node:crypto';
export function sameSecret(left:string|undefined,right:string):boolean {
  if(!left)return false;
  const a=Buffer.from(left),b=Buffer.from(right);
  return a.length===b.length&&timingSafeEqual(a,b);
}
export class Sessions {
  private sessions=new Map<string,{csrf:string;expires:number}>();
  private codes=new Map<string,number>();
  issue():string {const code=crypto.randomUUID();this.codes.set(code,Date.now()+60_000);return code;}
  exchange(code:string){const expires=this.codes.get(code)??0;this.codes.delete(code);if(expires<Date.now())return undefined;const id=crypto.randomUUID();this.sessions.set(id,{csrf:crypto.randomUUID(),expires:Date.now()+12*60*60_000});return id;}
  read(cookie:string){return this.byId(this.cookieId(cookie));}
  private cookieId(cookie:string){return cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('asana_next='))?.slice(11)??'';}
  private byId(id:string){const session=this.sessions.get(id);if(!session)return undefined;if(session.expires<Date.now()){this.sessions.delete(id);return undefined;}return session;}
}
