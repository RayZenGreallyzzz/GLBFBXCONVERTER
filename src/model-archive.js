// Offline archive import for Meshy/Tripo OBJ+MTL packs and glTF resources.
// A ZIP is only a container: its actual 3D entry is passed into the existing
// strict format parsers. Never assume a renamed .zip is a valid 3D model.
import { unzipSync } from 'fflate';

export const MODEL_ZIP_INPUTS=Object.freeze(['glb','gltf','vrm','fbx','obj','dae','stl','ply','usdz','bvh']);
const ASSETS=new Set([...MODEL_ZIP_INPUTS,'mtl','bin','png','jpg','jpeg','webp','bmp','gif']);
const SIZE_LIMIT=250*1048576, TOTAL_UNPACKED_LIMIT=350*1048576;
const MAX_ENTRIES=180;
const EXT_PRIORITY=['glb','vrm','gltf','fbx','obj','dae','ply','stl','usdz','bvh'];
const extension=name=>String(name).toLowerCase().split('.').pop();

function safeName(name){
 const path=String(name||'').replace(/\\/g,'/');
 // Do not allow dangerous or ambiguous paths in model archives.
 if(path.startsWith('/')||path.includes('\0')||
   path.split('/').some(x=>x==='..'||x==='.')||/^[a-z]:/i.test(path))
   throw Error('Небезопасный путь в ZIP: '+name);
 return path.split('/').pop();
}
function modelFile(name,content){
 const blob=new Blob([content],{type:'application/octet-stream'});
 // Blob with a filename behaves like a File (also in Node and old WebViews).
 // URL.createObjectURL(), arrayBuffer() and text() work in both environments.
 Object.defineProperty(blob,'name',{value:name,enumerable:true});
 return blob;
}
export function extractModelZip(bytes){
 const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
 if(data.byteLength<22||
   !(data[0]===0x50&&data[1]===0x4b&&[3,5,7].includes(data[2])&&[4,6,8].includes(data[3])))
   throw Error('Файл не является ZIP-архивом');
 if(data.byteLength>SIZE_LIMIT)throw Error('ZIP больше 250 МБ: ограничение Android');
 let total=0,count=0;
 const files=unzipSync(data,{filter(entry){
   const filename=safeName(entry.name);
   if(!filename||!ASSETS.has(extension(filename)))return false;
   count++;
   if(count>MAX_ENTRIES)throw Error('Слишком много файлов в ZIP (>180)');
   const size=entry.originalSize;
   if(!Number.isFinite(size)||size<0||size>SIZE_LIMIT)
     throw Error('Файл в ZIP слишком большой: '+filename);
   total+=size;
   if(total>TOTAL_UNPACKED_LIMIT)
     throw Error('ZIP распаковывается более чем в 350 МБ — недостаточно памяти Android');
   return true;
 }});
 const named=new Map(),dupes=new Set();
 for(const [path,bytes] of Object.entries(files)){
   const name=safeName(path);
   if(!name)continue;
   const key=name.toLowerCase();
   if(named.has(key))dupes.add(name);
   named.set(key,modelFile(name,bytes));
 }
 if(dupes.size)throw Error('ZIP содержит несколько файлов с одинаковыми именами: '+[...dupes].join(', '));
 const list=[...named.values()];
 const main=EXT_PRIORITY.map(ext=>list.find(f=>extension(f.name)===ext)).find(Boolean);
 if(!main)throw Error('В ZIP нет модели GLB, glTF, FBX, OBJ, VRM, DAE, PLY или STL');
 return {file:main,files:list,entryCount:list.length,unpackedBytes:total,format:extension(main.name)};
}
