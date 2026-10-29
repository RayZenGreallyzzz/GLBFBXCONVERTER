// FBX 7.2/7.3 binary validation for legacy Mixamo export.
// The exporter is asked to write the target version directly; we NEVER
// relabel the signature/version of a modern FBX as a compatibility workaround.
const MAGIC='Kaydara FBX Binary  \0\x1a\0';
const NEEDLE=new TextEncoder().encode('FBXVersion');

export function verifyLegacyFbxMetadata(value,expectedVersion){
  if(![7200,7300].includes(expectedVersion))throw Error('Нужна версия FBX 2012 либо 2013');
  const bytes=value instanceof Uint8Array?value:new Uint8Array(value);
  if(bytes.length<128)throw Error('Слишком короткий FBX');
  const header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let i=0;i<MAGIC.length;i++){
    if(bytes[i]!==MAGIC.charCodeAt(i))throw Error('Неверная сигнатура FBX');
  }
  const version=header.getUint32(23,true);
  if(version!==expectedVersion)throw Error('Версия FBX в заголовке не совпадает: '+version);
  // Validate FBXHeaderExtension/FBXVersion metadata too, not just the header.
  // The binary node FBXVersion contains the property type 'I' then a uint32.
  let internalVersion=null;
  for(let i=27;i<Math.min(bytes.length-NEEDLE.length-5,16384);i++){
    let matched=true;
    for(let j=0;j<NEEDLE.length;j++)if(bytes[i+j]!==NEEDLE[j]){
      matched=false;break;
    }
    if(!matched)continue;
    const at=i+NEEDLE.length;
    if(bytes[at]===73){ // 'I': 32-bit integer FBX property.
      internalVersion=header.getUint32(at+1,true);
      break;
    }
  }
  if(internalVersion!==expectedVersion)
    throw Error('FBXHeaderExtension содержит неверную версию: '+internalVersion);
  return {version,internalVersion,bytes:bytes.byteLength};
}
