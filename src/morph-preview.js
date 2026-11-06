function collect(root){const nodes=[];root?.traverse(n=>{if(n.isMesh&&n.morphTargetInfluences?.length)nodes.push(n)});return nodes}
function names(node){const values=Object.entries(node.morphTargetDictionary||{});return Array.from({length:node.morphTargetInfluences.length},(_,i)=>node.userData?.targetNames?.[i]??values.find(([,v])=>v===i)?.[0]??String(i))}
// View-only overrides. Each instance retains its own original defaults, and
// scene exports always restore them rather than exporting a manual expression.
export class MorphPreview{
 constructor(){this.entries=[];this.compatible=true}
 setModels(source,preview=null){
  this.dispose();const a=collect(source),b=collect(preview);
  this.compatible=!preview||(a.length===b.length&&a.every((n,i)=>JSON.stringify(names(n))===JSON.stringify(names(b[i]))));
  this.entries=a.map((node,i)=>({node,result:this.compatible?b[i]:null,names:names(node),defaults:Array.from(node.morphTargetInfluences),resultDefaults:b[i]?Array.from(b[i].morphTargetInfluences):null,values:Array.from(node.morphTargetInfluences)}));
 }
 setWeight(mesh,index,value){
  const e=this.entries[mesh];if(!this.compatible||!e||!Number.isInteger(index)||index<0||index>=e.values.length||!Number.isFinite(value))throw Error('Неверная форма мимики');
  e.values[index]=value;this.apply();
 }
 apply(){for(const e of this.entries)for(let i=0;i<e.values.length;i++){e.node.morphTargetInfluences[i]=e.values[i];if(e.result)e.result.morphTargetInfluences[i]=e.values[i]}}
 reset(){for(const e of this.entries){e.values=e.defaults.slice();for(let i=0;i<e.values.length;i++){e.node.morphTargetInfluences[i]=e.defaults[i];if(e.result)e.result.morphTargetInfluences[i]=e.resultDefaults[i]}}}
 dispose(){this.reset();this.entries=[];this.compatible=true}
}
