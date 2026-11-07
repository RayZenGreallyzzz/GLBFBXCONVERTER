import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {loadMotionSource} from '../src/motion-import.js';
import {encodeMotionGlb} from './build-motion-library.mjs';
globalThis.ProgressEvent??=class{constructor(type,values){this.type=type;Object.assign(this,values)}};
const input=resolve(process.argv[2]),library=resolve(process.argv[3]||'public/motions');
const manifest=JSON.parse(await readFile(join(library,'index.json'),'utf8')),ids=new Set(manifest.clips.filter(c=>c.family==='monster').map(c=>c.id));
let count=0;const unique=new Set(),warnings=[];
for(const name of (await readdir(input)).filter(n=>n.endsWith('.glb')).sort()){
 const bytes=new Uint8Array(await readFile(join(input,name)));let source;try{source=await loadMotionSource({path:name,format:'glb',size:bytes.length,read:async()=>bytes})}catch(error){warnings.push({file:name,warning:error.message});continue}
 for(const clip of source.clips){const id=createHash('sha256').update(encodeMotionGlb(source,clip,{family:'monster'})).digest('hex');if(!ids.has(id))throw Error('Missing monster clip: '+name+' / '+clip.name);count++;unique.add(id)}
 for(const warning of source.warnings)if(warning.startsWith('Пропущено'))warnings.push({file:name,warning});
}
const report={supportedSourceClips:count,uniqueMonsterClips:unique.size,warnings};await writeFile(join(library,'blend-coverage.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
