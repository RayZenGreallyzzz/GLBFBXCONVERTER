// Only metadata is loaded at startup. Each entry fetches one mesh-free GLB
// when selected or visible among the six thumbnail cards; no scene cache.
const MiB=1048576;
export async function openEmbeddedMotions({fetcher=globalThis.fetch,signal}={}){
 const response=await fetcher('/motions/index.json',{signal});
 if(!response.ok)throw Error('Не найден каталог встроенных движений ('+response.status+')');
 const bytes=new Uint8Array(await response.arrayBuffer());
 if(bytes.length>4*MiB)throw Error('Слишком большой каталог движений');
 const manifest=JSON.parse(new TextDecoder().decode(bytes));
 if(manifest.version!==1||!Array.isArray(manifest.clips)||!manifest.clips.length||manifest.clips.length>8192)throw Error('Неподдерживаемый каталог встроенных движений');
 const ids=new Set();
 return manifest.clips.map(clip=>{
  if(!/^[a-f0-9]{64}$/.test(clip.id)||ids.has(clip.id)||typeof clip.title!=='string'||!clip.title||clip.title.length>240||!['idle','walk','run','attack','other'].includes(clip.category)||!Number.isSafeInteger(clip.bytes)||clip.bytes<20||clip.bytes>8*MiB||!Number.isFinite(clip.duration)||clip.duration<=0)throw Error('Повреждена запись встроенного движения');
  ids.add(clip.id);
  return {id:clip.id,title:clip.title,category:clip.category,path:clip.category+'/'+clip.title+'.glb',label:clip.title,source:String(clip.source||''),aliases:Array.isArray(clip.aliases)?clip.aliases.filter(a=>typeof a==='string'):[],format:'glb',size:clip.bytes,embedded:true,
   async read({signal}={}){
    const result=await fetcher('/motions/clips/'+clip.id+'.glb',{signal});
    if(!result.ok)throw Error('Не удалось открыть встроенное движение ('+result.status+')');
    const data=new Uint8Array(await result.arrayBuffer());if(data.length!==clip.bytes)throw Error('Повреждён размер встроенного движения');return data;
   },
   resource:async()=>{throw Error('Встроенному движению не нужны внешние ресурсы')}
  };
 });
}
