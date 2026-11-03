import { resolve, relative } from 'node:path';
import type { BunPlugin } from 'bun';
export async function webAssetsPlugin():Promise<BunPlugin>{
  const root=resolve(import.meta.dir,'..');
  const build=Bun.spawn([process.execPath,'run','--filter','@asana-cli/web','build'],{cwd:root,stdout:'inherit',stderr:'inherit'});
  if(await build.exited!==0)throw new Error('Web build failed');
  const directory=resolve(root,'apps/web/dist');const assets:Record<string,{type:string;body:string}>={};
  for await(const name of new Bun.Glob('**/*').scan({cwd:directory,onlyFiles:true})){
    const file=Bun.file(resolve(directory,name));assets[`/${name}`]={type:file.type,body:await file.text()};
  }
  return {name:'embedded-web',setup(build){build.onLoad({filter:/local-runtime\/src\/assets\.ts$/},()=>({loader:'ts',contents:`export const embeddedAssets=${JSON.stringify(assets)};` }));}};
}
