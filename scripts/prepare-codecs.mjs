// Ship version-matched codec assets in the APK. No runtime CDN requests.
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const root=new URL('../',import.meta.url);
const out=new URL('public/codecs/',root);
const three=dirname(dirname(require.resolve('three')));
const draco=dirname(require.resolve('draco3dgltf'));
const ktx=dirname(dirname(fileURLToPath(import.meta.resolve('ktx2-encoder'))));
for(const dir of ['draco','basis','ktx2'])await mkdir(new URL(dir+'/',out),{recursive:true});
for(const name of ['draco_wasm_wrapper.js','draco_decoder.wasm'])
 await copyFile(join(three,'examples/jsm/libs/draco/gltf',name),new URL('draco/'+name,out));
for(const [source,dest,globalName] of [
 ['draco_decoder_gltf_nodejs.js','decoder.js','DracoDecoderModule'],
 ['draco_encoder_gltf_nodejs.js','encoder.js','DracoEncoderModule']
]){
 const text=await readFile(join(draco,source),'utf8');
 await writeFile(new URL('draco/'+dest,out),text+'\nexport default '+globalName+';\n');
}
for(const name of ['draco_decoder_gltf.wasm','draco_encoder.wasm'])
 await copyFile(join(draco,name),new URL('draco/'+name,out));
for(const name of ['basis_transcoder.js','basis_transcoder.wasm'])
 await copyFile(join(three,'examples/jsm/libs/basis',name),new URL('basis/'+name,out));
await writeFile(new URL('basis/transcoder.js',out),
 await readFile(join(three,'examples/jsm/libs/basis/basis_transcoder.js'),'utf8')+'\nexport default BASIS;\n');
await copyFile(join(ktx,'basis/basis_encoder.wasm'),new URL('ktx2/basis_encoder.wasm',out));
await copyFile(join(draco,'README.md'),new URL('draco/README.txt',out));
await copyFile(join(ktx,'../THIRD_PARTY_NOTICES.md'),new URL('ktx2/THIRD_PARTY_NOTICES.md',out)).catch(async()=>{
 await copyFile(join(ktx,'../../THIRD_PARTY_NOTICES.md'),new URL('ktx2/THIRD_PARTY_NOTICES.md',out));
});
console.log('Offline Draco decoder/encoder and KTX2 transcoder/encoder prepared.');
