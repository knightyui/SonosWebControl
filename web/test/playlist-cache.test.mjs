import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createPlaylistCache} from '../public/playlist-cache.mjs';

const playlist=(id='liked',title='Example')=>({id,title,songs:[{id:1,mid:'example-mid',index:1,title:'Example song'}]});
function memoryStorage(){
  let value=null;
  return {getItem:()=>value,setItem:(_,next)=>{value=next;},removeItem:()=>{value=null;}};
}

test('reopening restores the last full playlist and isolates accounts and playlists',()=>{
  const storage=memoryStorage();
  createPlaylistCache(storage).write('account-a',playlist());
  const reopened=createPlaylistCache(storage);
  assert.equal(reopened.latest().data.songs[0].title,'Example song');
  assert.equal(reopened.read('account-b','liked'),null);
  assert.equal(reopened.read('account-a','other'),null);
  reopened.write('account-b',playlist('other'));
  assert.equal(reopened.latest().account,'account-b');
  assert.equal(reopened.read('account-a','liked').data.id,'liked');
  reopened.clear();assert.equal(reopened.latest(),null);
});

test('damaged cache and unavailable storage never prevent loading',()=>{
  const damaged=createPlaylistCache({getItem:()=>'{broken',setItem:()=>{throw Error('Quota exceeded');},removeItem:()=>{throw Error('Blocked');}});
  assert.equal(damaged.latest(),null);
  assert.doesNotThrow(()=>damaged.write('account-a',playlist()));
  assert.doesNotThrow(()=>damaged.clear());
  const invalid=createPlaylistCache({getItem:()=>JSON.stringify({version:1,entries:[{account:'a',data:{id:'liked',songs:null}}]})});
  assert.equal(invalid.latest(),null);
});

test('quota pressure evicts older playlists while retaining the newest',()=>{
  const storage=memoryStorage(),cache=createPlaylistCache(storage);
  cache.write('a',playlist('1'));cache.write('a',playlist('2'));
  const limited=createPlaylistCache({...storage,setItem:(key,value)=>{
    if(JSON.parse(value).entries.length>1)throw Error('Quota exceeded');
    storage.setItem(key,value);
  }});
  limited.write('a',playlist('3'));
  assert.equal(limited.latest().data.id,'3');
  assert.equal(limited.read('a','1'),null);
});

async function harness(){
  const script=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{value:'',textContent:'',hidden:true,disabled:false,options:[],
      add(option){this.options.push(option);},replaceChildren(){this.options=[];},querySelectorAll:()=>[]});
    return elements.get(id);
  };
  const context=vm.createContext({$:element,Option:function(text,value){return {text,value};},
    songs:[],visible:60,libraryAccount:'a',libraryPlaylistId:'liked',libraryReady:true,playlistRequest:0,
    displayedPlaylistId:'',locateGeneration:0,playlistOptions:[],renderCount:0,toasts:[],
    renderSongs(){context.renderCount++;},markCurrentPlaylistSong(){},renderPlaylistChoices(){},
    toast(message){context.toasts.push(message);},playlistCache:createPlaylistCache(memoryStorage())});
  vm.runInContext(script.slice(script.indexOf('function displayPlaylist('),script.indexOf('async function loadHistory(')),context);
  return {context,element};
}

test('background refresh failure keeps cached songs visible without a success/error toast storm',async()=>{
  const {context,element}=await harness();
  context.displayPlaylist(playlist());
  context.api=async()=>{throw Error('Network offline');};
  await context.loadPlaylist();
  assert.equal(context.songs[0].mid,'example-mid');
  assert.equal(context.toasts.length,0);
  assert.match(element('account-state').textContent,/继续显示/);
  assert.equal(element('refresh').disabled,false);
});

test('unchanged background data preserves list rendering and scroll position',async()=>{
  const {context}=await harness();
  context.displayPlaylist(playlist());const rendered=context.renderCount;
  context.visible=420;context.api=async()=>({...playlist(),account:'a'});
  await context.loadPlaylist();
  assert.equal(context.renderCount,rendered);
  assert.equal(context.visible,420);
});

test('late responses cannot overwrite a newly selected playlist or account',async()=>{
  const {context}=await harness();
  let finish;
  context.api=()=>new Promise(resolve=>{finish=resolve;});
  const old=context.loadPlaylist();
  context.setLibraryContext('b','other');
  finish({...playlist(),account:'a'});await old;
  assert.equal(context.libraryAccount,'b');
  assert.equal(context.songs.length,0);
  assert.equal(context.playlistCache.read('a','liked'),null);
});

test('fresh playlist changes replace the snapshot and seed the next reopening',async()=>{
  const {context}=await harness();
  context.displayPlaylist(playlist());
  const updated={...playlist('liked','Updated'),account:'a',songs:[{id:2,mid:'new-mid',index:1,title:'New song'}]};
  context.api=async()=>updated;
  await context.loadPlaylist(true);
  assert.equal(context.songs[0].mid,'new-mid');
  assert.equal(context.playlistCache.latest().data.title,'Updated');
});

test('a response for another account cannot populate the current browser cache',async()=>{
  const {context,element}=await harness();
  context.displayPlaylist(playlist());context.api=async()=>({...playlist(),account:'b'});
  await context.loadPlaylist();
  assert.equal(context.playlistCache.latest(),null);
  assert.match(element('account-state').textContent,/歌单已切换/);
});

test('confirming cached rows does not re-enable a song already being played',async()=>{
  const {context,element}=await harness();
  context.displayPlaylist(playlist());
  const pending={disabled:true,dataset:{libraryPending:'true'}},playing={disabled:true,dataset:{}};
  element('song-list').querySelectorAll=selector=>selector.includes('data-library-pending')?[pending]:[pending,playing];
  context.displayPlaylist(playlist());
  assert.equal(pending.disabled,false);
  assert.equal(playing.disabled,true);
});

test('simultaneous playlist requests share a fetch and recover after failed refreshes',async()=>{
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  let finish,fetches=0;
  const context=vm.createContext({historyAccount:()=> 'a',selectedPlaylistId:'liked',playlistLoads:new Map(),
    fetchPlaylist:()=>{fetches++;return new Promise(resolve=>{finish=resolve;});}});
  vm.runInContext(source.slice(source.indexOf('async function playlist(refresh='),source.indexOf('async function fetchPlaylist(')),context);
  const first=context.playlist(),second=context.playlist();
  assert.equal(fetches,1);finish(playlist());await Promise.all([first,second]);
  assert.equal(context.playlistLoads.size,0);
  context.fetchPlaylist=async()=>{throw Error('Offline');};
  await assert.rejects(context.playlist(true),/Offline/);
  assert.equal(context.playlistLoads.size,0);
  context.fetchPlaylist=async()=>playlist();
  assert.equal((await context.playlist()).id,'liked');
});
