import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {STYLE_ASSETS,buildStyleBundle} from '../style-assets.mjs';

const publicDirectory=fileURLToPath(new URL('../public/',import.meta.url));

test('the static fallback and server bundle use the same ordered component assets',async()=>{
  const manifest=await readFile(new URL('../public/style.css',import.meta.url),'utf8');
  const imports=[...manifest.matchAll(/@import url\("\.\/(styles\/[^"\n]+)"\);/g)].map(match=>match[1]);
  assert.deepEqual(imports,[...STYLE_ASSETS]);
  assert.equal(new Set(imports).size,imports.length);
  assert.equal(imports.at(0),'styles/tokens.css');
  assert.deepEqual(imports.slice(-2),['styles/responsive.css','styles/accessibility.css']);
});

test('all component sources are bundled into one complete stylesheet without imports',async()=>{
  const bundle=await buildStyleBundle(publicDirectory);
  let previous=-1;
  for(const asset of STYLE_ASSETS){
    const source=await readFile(new URL(`../public/${asset}`,import.meta.url),'utf8');
    const index=bundle.indexOf(source);
    assert.ok(index>previous,`${asset} should appear once in the declared load order`);
    previous=index;
  }
  assert.doesNotMatch(bundle,/@import\b/);
});

test('missing style sources fail explicitly instead of producing a partial bundle',async()=>{
  await assert.rejects(buildStyleBundle(new URL('../missing-style-fixture/',import.meta.url).pathname),{code:'ENOENT'});
});

test('engine-specific slider pseudo-elements are kept in separate selector lists',async()=>{
  const bundle=await buildStyleBundle(publicDirectory);
  for(const block of bundle.matchAll(/([^{}]+)\{[^{}]*\}/g)){
    const selector=block[1];
    assert.ok(!(selector.includes('::-webkit-')&&selector.includes('::-moz-')),
      'mixing unsupported pseudo-elements invalidates the whole selector list');
  }
});

test('the HTTP server serves the complete CSS bundle and component assets',async()=>{
  const temporary=await mkdtemp(path.join(tmpdir(),'sonos-style-http-'));
  const reservation=createServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{
    env:{...process.env,HOST:'127.0.0.1',PORT:String(port),SONOS_IP:'',SONOS_DATA_DIR:temporary},
    stdio:['ignore','pipe','pipe']
  });
  let deadline;
  try{
    await Promise.race([
      once(child.stdout,'data'),
      once(child,'error').then(([error])=>{throw error;}),
      once(child,'exit').then(([code])=>{throw Error(`Static test server exited: ${code}`);}),
      new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Static test server did not start')),10000);})
    ]);
    clearTimeout(deadline);
    const origin=`http://127.0.0.1:${port}`;
    const page=await fetch(origin),html=await page.text();
    assert.equal(page.status,200);
    assert.equal([...html.matchAll(/rel="stylesheet"/g)].length,1);
    const response=await fetch(`${origin}/style.css`);
    assert.match(response.headers.get('content-type'),/^text\/css/);
    assert.equal(response.headers.get('cache-control'),'no-cache');
    assert.equal(await response.text(),await buildStyleBundle(publicDirectory));
    for(const asset of STYLE_ASSETS){
      const response=await fetch(`${origin}/${asset}`);
      assert.equal(response.status,200,asset);
      assert.match(response.headers.get('content-type'),/^text\/css/);
    }
    assert.equal((await fetch(`${origin}/style-assets.mjs`)).status,404);
  }finally{
    clearTimeout(deadline);
    if(child.pid&&child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}
    await rm(temporary,{recursive:true,force:true});
  }
});
