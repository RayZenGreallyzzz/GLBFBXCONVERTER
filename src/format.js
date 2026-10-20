// Pure glTF and FBX structural checks; never trust an extension or filename.
export const FBX_VERSIONS={7200:'FBX 7.2 (2012)',7300:'FBX 7.3 (2013)',7400:'FBX 7.4 (2014–2015)',7500:'FBX 7.5 (2016–2018)',7700:'FBX 7.7 (2019+)'};
function bytes(value){return value instanceof Uint8Array?value:new Uint8Array(value)}
export function inspectFbx(value){
  const b=bytes(value),magic='Kaydara FBX Binary  \0\x1a\0';
  if(b.length>=27&&[...magic].every((ch,i)=>b[i]===ch.charCodeAt(0))){
    const version=new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(23,true);
    return {type:'fbx',version,label:FBX_VERSIONS[version]||'FBX '+version,binary:true};
  }
  const text=new TextDecoder().decode(b.subarray(0,1200));
  if(/;\s*FBX\s+\d/.test(text))return {type:'fbx',version:null,label:'FBX ASCII',binary:false};
  throw Error('Некорректный заголовок FBX');
}
export function inspectGlb(value){
  const b=bytes(value);if(b.length<20)throw Error('GLB слишком короткий');
  const v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  if(v.getUint32(0,true)!==0x46546c67||v.getUint32(4,true)!==2||v.getUint32(8,true)!==b.length)throw Error('Повреждён заголовок GLB 2.0');
  const n=v.getUint32(12,true);if(n%4||n+20>b.length||v.getUint32(16,true)!==0x4e4f534a)throw Error('Некорректный JSON блок GLB');
  let json;try{json=JSON.parse(new TextDecoder().decode(b.subarray(20,20+n)).trim())}catch{throw Error('Некорректный JSON GLB')}
  if(json.asset?.version!=='2.0')throw Error('Требуется glTF 2.0');
  if(json.buffers?.length>1)throw Error('Ссылки на внешние буферы не поддерживаются');
  return {type:'glb',meshes:json.meshes?.length||0,skins:json.skins?.length||0,animations:json.animations?.length||0,images:json.images?.length||0,json,required:json.extensionsRequired||[]};
}
export function modelStats(root,clips=[]){
  const stats={meshes:0,skinned:0,bones:0,triangles:0,vertices:0,animations:clips.length,tracks:clips.reduce((x,c)=>x+(c.tracks?.length||0),0)};
  const materials=new Set(),textures=new Set();
  root?.traverse(node=>{
    if(node.isBone)stats.bones++;
    if(!node.isMesh)return;
    stats.meshes++;if(node.isSkinnedMesh)stats.skinned++;
    const g=node.geometry,p=g?.getAttribute('position'),ind=g?.index;
    stats.vertices+=p?.count||0;stats.triangles+=Math.floor((ind?.count||p?.count||0)/3);
    for(const m of Array.isArray(node.material)?node.material:[node.material]){
      if(!m)continue;materials.add(m.uuid);
      for(const v of Object.values(m))if(v?.isTexture)textures.add(v.uuid);
    }
  });
  return {...stats,materials:materials.size,textures:textures.size};
}
export function assertGlbPreserved(source,output,clips=[]){
  if(source.meshes>0&&output.meshes===0)throw Error('Потеряна геометрия');
  if(source.skinned>0&&!output.skins)throw Error('Потерян скелет');
  if(output.animations!==source.animations)throw Error('Потеряны анимации');
  const d=output.json,ns=(d.nodes||[]).filter(n=>n.skin!==undefined);
  if(source.skinned>ns.length)throw Error('Потеряна привязка меша к скелету');
  for(const n of ns){
    const skin=d.skins?.[n.skin],mesh=d.meshes?.[n.mesh];
    if(!skin?.joints?.length||!mesh?.primitives?.length)throw Error('Повреждена связь меша и костей');
    for(const p of mesh.primitives||[])if(p.attributes?.JOINTS_0===undefined||p.attributes?.WEIGHTS_0===undefined)throw Error('Потеряны веса костей');
  }
  const outputs=d.animations||[];
  for(let i=0;i<clips.length;i++){
    if(outputs[i]?.name!==(clips[i]?.name||'')||!outputs[i]?.channels?.length)throw Error('Пропала анимация '+(clips[i]?.name||i));
  }
  return true;
}
