import {parseFbxMotion} from './fbx-motion-core.js';
self.onmessage=({data})=>{try{const source=parseFbxMotion(data.bytes),buffers=new Set();for(const c of source.clips)for(const t of c.tracks){buffers.add(t.times.buffer);buffers.add(t.values.buffer)}self.postMessage({source},[...buffers])}catch(e){self.postMessage({error:e.message||String(e)})}};
