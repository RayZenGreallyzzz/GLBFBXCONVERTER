export function asBytes(value){
 if(value instanceof Uint8Array)return value;
 if(value instanceof ArrayBuffer)return new Uint8Array(value);
 if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
 throw Error('Ожидались двоичные данные модели');
}
export function asArrayBuffer(value){
 const b=asBytes(value);
 return b.byteOffset===0&&b.byteLength===b.buffer.byteLength
  ?b.buffer:b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
}
