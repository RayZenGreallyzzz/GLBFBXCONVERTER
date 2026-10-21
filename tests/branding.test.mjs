import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('classic launcher branding files are packaged and viewer splash is shown',()=>{
  const i=fs.readFileSync('public/branding/icon.webp');
  const s=fs.readFileSync('public/branding/splash.webp');
  const valid=b=>b.subarray(0,4).toString('ascii')==='RIFF' &&
    b.subarray(8,12).toString('ascii')==='WEBP';
  assert.ok(valid(i),'icon is real WebP');
  assert.ok(valid(s),'splash is real WebP');
  const html=fs.readFileSync('index.html','utf8');
  assert.match(html,/id="brand-splash"/);
  assert.match(html,/\/branding\/splash\.webp/);
  const js=fs.readFileSync('src/main.js','utf8');
  assert.match(js,/finishBrandSplash/);
  // App remains the old classic editor with NO MultiFormat imports.
  assert.ok(!js.includes('model-formats.js'));
});
