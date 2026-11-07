import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseSearchPage,hasMoreSearchResults} from '../search-pagination.mjs';
import {currentPlaylistIndex,visibleCountForIndex} from '../public/library-navigation.mjs';

test('catalog search page validation and last-page detection',()=>{
  assert.equal(parseSearchPage(null),1);
  assert.equal(parseSearchPage('7'),7);
  for(const invalid of ['0','1.5','1001','oops'])assert.throws(()=>parseSearchPage(invalid),/页码/);
  assert.equal(hasMoreSearchResults(1,65,30),true);
  assert.equal(hasMoreSearchResults(3,65,5),false);
  assert.equal(hasMoreSearchResults(2,60,30),false);
  assert.equal(hasMoreSearchResults(1,null,30),true);
  assert.equal(hasMoreSearchResults(2,null,12),false);
});

test('locate current song in a large playlist without rendering beyond its batch',()=>{
  const songs=Array.from({length:1643},(_,index)=>({id:index+100,index:index+1}));
  assert.equal(currentPlaylistIndex(songs,1500),1400);
  assert.equal(visibleCountForIndex(1400,songs.length),1440);
  assert.equal(visibleCountForIndex(0,songs.length),60);
  assert.equal(currentPlaylistIndex(songs,99999),-1);
  assert.equal(visibleCountForIndex(-1,songs.length),0);
});

test('catalog pagination and current-song navigation are wired to the page',async()=>{
  const [html,script,server]=await Promise.all([
    readFile(new URL('../public/index.html',import.meta.url),'utf8'),
    readFile(new URL('../public/app.js',import.meta.url),'utf8'),
    readFile(new URL('../server.mjs',import.meta.url),'utf8')
  ]);
  assert.match(html,/id="quick-search-more"/);
  assert.match(html,/id="locate-playing"/);
  assert.match(script,/page=\$\{page\}/);
  assert.match(script,/\$\('locate-playing'\)\.onclick=locatePlayingSong/);
  assert.match(server,/'library-navigation\.mjs'/);
});

test('accessible song lists and keyboard tabs retain their semantics',async()=>{
  const [html,script]=await Promise.all([
    readFile(new URL('../public/index.html',import.meta.url),'utf8'),
    readFile(new URL('../public/app.js',import.meta.url),'utf8')
  ]);
  assert.match(html,/id="song-list"[^>]*role="list"/);
  assert.match(html,/id="history-list"[^>]*role="list"/);
  assert.match(script,/entry\.setAttribute\('role','listitem'\)/);
  assert.match(script,/row\.setAttribute\('aria-current','true'\)/);
  assert.match(script,/event\.key==='ArrowRight'/);
});
