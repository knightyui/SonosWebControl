import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('every static element requested by the UI script exists in the page',async()=>{
  const [html,script]=await Promise.all([
    readFile(new URL('../public/index.html',import.meta.url),'utf8'),
    readFile(new URL('../public/app.js',import.meta.url),'utf8')
  ]);
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
  const requested=new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map(match=>match[1]));
  assert.deepEqual([...requested].filter(id=>!ids.has(id)),[]);
  assert.equal(ids.has('mobile-player-open'),false);
  assert.equal(ids.has('mobile-library-open'),true);
  assert.equal(ids.has('mobile-search-open'),true);
});

test('queue playback and editing both send the displayed track fingerprint',async()=>{
  const script=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(script,/\/api\/queue\/play[^\n]*key:track\.key/);
  assert.match(script,/\/api\/queue\/edit[^\n]*key:track\.key/);
});
