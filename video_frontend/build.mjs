import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const base=fileURLToPath(new URL('.',import.meta.url));
const result=await build({absWorkingDir:base,entryPoints:['video-client.js','presence-client.js'],outdir:fileURLToPath(new URL('../web/',import.meta.url)),bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'eof',metafile:true});
const packages=new Set();
for(const input of Object.keys(result.metafile.inputs)){
  const match=input.replaceAll('\\','/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if(match)packages.add(match[1]);
}
let notices='SafeNest third-party browser bundle notices\n\n';
for(const name of [...packages].sort()){
  const dir=resolve(base,'node_modules',name);
  const pkg=JSON.parse(await readFile(resolve(dir,'package.json'),'utf8'));
  notices+=`${name} ${pkg.version} — ${pkg.license || 'See included license'}\n`;
  for(const file of ['LICENSE','LICENSE.md','LICENSE.txt','LICENSE-MIT','NOTICE']){
    try{notices+=(await readFile(resolve(dir,file),'utf8'))+'\n';}catch{}
  }
  notices+='\n';
}
await writeFile(fileURLToPath(new URL('../web/THIRD_PARTY_NOTICES.txt',import.meta.url)),notices);
console.log('Built pinned LiveKit and Realtime browser clients (no CDN) and third-party notices.');
