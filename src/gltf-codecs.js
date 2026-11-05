import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {KTX2Loader} from 'three/addons/loaders/KTX2Loader.js';
import {decompress} from 'three/addons/utils/WebGLTextureUtils.js';
import {MeshoptDecoder} from 'meshoptimizer';

let draco=null,ktx2=null,activeRenderer=null;
export function configureGltfCodecs(renderer){
 activeRenderer=renderer;
 draco?.dispose();ktx2?.dispose();
 draco=new DRACOLoader().setDecoderPath('/codecs/draco/').setWorkerLimit(1);
 ktx2=new KTX2Loader().setTranscoderPath('/codecs/basis/').setWorkerLimit(1).detectSupport(renderer);
}
export function createModelLoader(manager){
 const loader=new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
 if(draco)loader.setDRACOLoader(draco);
 if(ktx2){
  // A multi-file glTF resolves KTX2 image URLs with its own local-file map.
  const textures=manager?new KTX2Loader(manager).setTranscoderPath('/codecs/basis/')
   .setWorkerLimit(1).detectSupport(activeRenderer):ktx2;
  loader.setKTX2Loader(textures);
  if(manager)loader.disposeCodecs=()=>textures.dispose();
 }
 return loader;
}
export function createModelExporter(){
 return new GLTFExporter().setTextureUtils({decompress});
}
