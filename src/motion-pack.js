import {inflateSync} from 'fflate';

const MiB=1048576,MAX_FILE=64*MiB,MAX_ZIP=128*MiB,MAX_TOTAL=256*MiB;
const formats=new Set(['bvh','fbx','glb','gltf']),ext=p=>p.toLowerCase().split('.').pop();
const decoder=new TextDecoder('utf-8',{fatal:true});
export function motionPath(value){
 const path=String(value).replace(/\\/g,'/');
 if(!path||path.startsWith('/')||/^[a-z]:/i.test(path)||path.includes('\0')||path.split('/').some(p=>p==='..'||p==='.'))throw Error('Небезопасный или неоднозначный путь в пакете: '+path);
 return path;
}
function resourcePath(base,uri){
 if(/[?#]/.test(uri)||/^[a-z][a-z0-9+.-]*:/i.test(uri)||uri.startsWith('/'))throw Error('Внешний ресурс анимации запрещён: '+uri);
 let decoded;try{decoded=decodeURIComponent(uri)}catch{throw Error('Некорректный путь ресурса')}
 const parts=base.split('/').slice(0,-1);for(const p of decoded.replace(/\\/g,'/').split('/')){if(!p||p==='.')continue;if(p==='..'){if(!parts.length)throw Error('Ресурс выходит за пределы пакета');parts.pop()}else parts.push(p)}return motionPath(parts.join('/'));
}
const table=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0});
function crc32(bytes){let crc=0xffffffff;for(const b of bytes)crc=table[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0}
async function slice(file,start,length){if(start<0||length<0||start+length>file.size)throw Error('Повреждён размер ZIP');return new Uint8Array(await file.slice(start,start+length).arrayBuffer())}
export async function indexMotionZip(file){
 if(file.size<22||file.size>MAX_ZIP)throw Error('ZIP анимаций: до 128 МиБ');
 const tail=await slice(file,Math.max(0,file.size-65557),Math.min(file.size,65557)),view=new DataView(tail.buffer);let end=-1;
 for(let i=tail.length-22;i>=0;i--)if(view.getUint32(i,true)===0x06054b50&&i+22+view.getUint16(i+20,true)===tail.length){end=i;break}
 if(end<0)throw Error('Не найден каталог ZIP');
 const count=view.getUint16(end+10,true),size=view.getUint32(end+12,true),offset=view.getUint32(end+16,true);
 if(view.getUint16(end+4,true)||view.getUint16(end+6,true)||view.getUint16(end+8,true)!==count||count>400||size>4*MiB||offset+size>file.size-tail.length+end)throw Error('ZIP64, многотомные ZIP или более 400 файлов не поддерживаются');
 const central=await slice(file,offset,size),cv=new DataView(central.buffer),entries=new Map();let at=0,total=0;
 for(let i=0;i<count;i++){
  if(at+46>central.length||cv.getUint32(at,true)!==0x02014b50)throw Error('Повреждён каталог ZIP');
  const flags=cv.getUint16(at+8,true),method=cv.getUint16(at+10,true),crc=cv.getUint32(at+16,true),compressed=cv.getUint32(at+20,true),length=cv.getUint32(at+24,true),nameLength=cv.getUint16(at+28,true),extra=cv.getUint16(at+30,true),comment=cv.getUint16(at+32,true),local=cv.getUint32(at+42,true);
  if(at+46+nameLength+extra+comment>central.length||cv.getUint16(at+34,true))throw Error('Повреждена запись ZIP');
  const name=motionPath(decoder.decode(central.subarray(at+46,at+46+nameLength)));at+=46+nameLength+extra+comment;
  if(name.endsWith('/')||name.startsWith('__MACOSX/')||!(formats.has(ext(name))||ext(name)==='bin'))continue;
  if(flags&1||![0,8].includes(method))throw Error('Зашифрованный или неподдерживаемый файл ZIP: '+name);
  if(length>MAX_FILE||local+30+compressed>offset)throw Error('Слишком большой или повреждённый файл ZIP: '+name);
  total+=length;if(total>MAX_TOTAL)throw Error('Пакет анимаций распаковывается более чем в 256 МиБ');
  const key=name.toLowerCase();if(entries.has(key))throw Error('Повторный путь в ZIP: '+name);
  entries.set(key,{path:name,size:length,async read(){
   const header=await slice(file,local,30),hv=new DataView(header.buffer);if(hv.getUint32(0,true)!==0x04034b50||hv.getUint16(6,true)!==flags||hv.getUint16(8,true)!==method)throw Error('Повреждён заголовок файла ZIP');
   const nl=hv.getUint16(26,true),el=hv.getUint16(28,true),rawName=await slice(file,local+30,nl);if(motionPath(decoder.decode(rawName))!==name||local+30+nl+el+compressed>offset)throw Error('Не совпали пути или размеры ZIP');
   const bytes=await slice(file,local+30+nl+el,compressed),out=method===0?bytes:inflateSync(bytes,{out:new Uint8Array(length)});
   if(out.length!==length||crc32(out)!==crc)throw Error('Повреждён файл анимации в ZIP: '+name);return out;
  }});
 }return entries;
}
export async function openMotionPack(files){
 if(files.length>400)throw Error('За один раз можно выбрать до 400 файлов');
 const sources=[];for(const file of files){
  let entries;
  if(ext(file.name)==='zip')entries=await indexMotionZip(file);
  else{if(file.size>MAX_FILE)throw Error('Файл анимации больше 64 МиБ: '+file.name);continue}
  for(const entry of entries.values())if(formats.has(ext(entry.path)))sources.push({...entry,label:file.name+' / '+entry.path,format:ext(entry.path),resource:uri=>{const path=resourcePath(entry.path,uri),item=entries.get(path.toLowerCase());if(!item||ext(path)!=='bin')throw Error('Не найден BIN: '+path);return item.read()}});
 }
 const loose=new Map();for(const file of files)if(ext(file.name)!=='zip'){const path=motionPath(file.webkitRelativePath||file.name),key=path.toLowerCase();if(loose.has(key))throw Error('Повторное имя файла: '+path);loose.set(key,{path,size:file.size,read:async()=>new Uint8Array(await file.arrayBuffer())})}
 for(const entry of loose.values())if(formats.has(ext(entry.path)))sources.push({...entry,label:entry.path,format:ext(entry.path),resource:uri=>{const path=resourcePath(entry.path,uri),item=loose.get(path.toLowerCase());if(!item||ext(path)!=='bin')throw Error('Выбери glTF вместе с BIN: '+path);return item.read()}});
 if(!sources.length)throw Error('В пакете нет анимаций BVH, FBX, GLB или glTF');if(sources.length>200)throw Error('За один раз можно выбрать до 200 файлов анимаций');
 return sources.sort((a,b)=>a.label.localeCompare(b.label));
}
