import {cutDetail,detailPiece,paintCut} from './detail-knife.js';
import {assembleDetails} from './details-assemble.js';

self.onmessage=async({data})=>{
  try {
    const {operation,input,parts,options}=data;
    const onProgress=value=>self.postMessage({progress:value});
    let result;
    if(operation==='cut')result=await cutDetail(input,options);
    else if(operation==='paint')result=await paintCut(input,options);
    else if(operation==='piece')result=await detailPiece(input,options);
    else if(operation==='assemble')result=await assembleDetails(input,parts,{...options,onProgress});
    else throw Error('Действие не найдено.');
    const transferred=[result.bytes?.buffer,result.vertices?.buffer].filter(Boolean);
    self.postMessage({result},transferred);
  }catch(error){self.postMessage({error:error.message||String(error)})}
};
