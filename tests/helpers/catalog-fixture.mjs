import {WebIO} from '@gltf-transform/core';
import {motionFixture} from './motion-fixture.mjs';
// Five real joints let the UI's existing automatic-preview confidence rule
// run. The two-joint motion-import fixture intentionally needs confirmation.
export async function catalogFixture(){
 const {doc}=await motionFixture(),nodes=doc.getRoot().listNodes(),hips=nodes.find(n=>n.getName()==='Hips'),arm=nodes.find(n=>n.getName()==='Arm');
 const spine=doc.createNode('Spine').setTranslation([0,.5,0]),head=doc.createNode('Head').setTranslation([0,.5,0]),hand=doc.createNode('Hand').setTranslation([.5,0,0]);
 hips.addChild(spine);spine.addChild(head);arm.addChild(hand);const skin=doc.getRoot().listSkins()[0];for(const bone of [spine,head,hand])skin.addJoint(bone);
 return {doc,bytes:await new WebIO().writeBinary(doc)};
}
