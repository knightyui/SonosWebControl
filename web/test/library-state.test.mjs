import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueryCache,createLibraryViewStore} from '../public/playlist-cache.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const store=()=>{const data=new Map();return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};};
test('query cache normalizes input, scopes account and page, and expires results',async()=>{
  let time=100,calls=0;const cache=createQueryCache({now:()=>time,ttl:10});
  const load=()=>({songs:[{title:String(++calls)}]});
  const a=await cache.load('a',' Live ',1,load);a.songs[0].title='mutated';
  assert.equal((await cache.load('a','live',1,load)).songs[0].title,'1');
  await cache.load('b','live',1,load);await cache.load('a','live',2,load);assert.equal(calls,3);
  time=110;await cache.load('a','live',1,load);assert.equal(calls,4);
});
test('query cache shares pending requests, releases failures and bounds retained results',async()=>{
  const cache=createQueryCache({limit:2}),gate=deferred();let calls=0;
  const loader=()=>{calls++;return gate.promise;};
  const first=cache.load('a','one',1,loader),second=cache.load('a','one',1,loader);
  await Promise.resolve();assert.equal(calls,1);gate.reject(Error('offline'));
  await assert.rejects(first,/offline/);await assert.rejects(second,/offline/);
  await cache.load('a','one',1,()=>++calls);
  await cache.load('a','two',1,()=>++calls);await cache.load('a','three',1,()=>++calls);
  await cache.load('a','one',1,()=>++calls);assert.equal(calls,5);
});
test('logout invalidates pending cache writes without deleting a newer in-flight query',async()=>{
  const cache=createQueryCache(),old=deferred(),fresh=deferred();
  const a=cache.load('a','same',1,()=>old.promise);cache.clear();
  const b=cache.load('a','same',1,()=>fresh.promise);old.resolve({value:'old'});await a;
  const c=cache.load('a','same',1,()=>{throw Error('should share fresh request');});
  fresh.resolve({value:'fresh'});assert.deepEqual(await b,await c);
  assert.deepEqual(await cache.load('a','same',1,()=>null),{value:'fresh'});
});
test('browse memory persists query, rendered count and scroll independently for each account and playlist',()=>{
  const storage=store(),views=createLibraryViewStore(storage),view={query:'现场',visible:540,top:3200};
  views.write('a','liked',view);views.write('a','other',{...view,query:'Live',top:10});views.write('b','liked',{...view,top:90});
  const reopened=createLibraryViewStore(storage);
  assert.deepEqual(reopened.read('a','liked'),{account:'a',id:'liked',...view});
  assert.equal(reopened.read('a','other').top,10);assert.equal(reopened.read('b','liked').top,90);assert.equal(reopened.read('c','liked'),null);
  for(let i=0;i<20;i++)views.write('a',String(i),view);
  assert.equal(views.read('a','liked'),null);assert.equal(views.read('a','19').visible,540);
});
test('invalid or unavailable browse storage does not interrupt interaction',()=>{
  const storage=store(),views=createLibraryViewStore(storage);
  for(const invalid of [{top:-1},{visible:Infinity},{visible:10001},{query:'x'.repeat(161)}])views.write('a','liked',{query:'',visible:60,top:0,...invalid});
  assert.equal(views.read('a','liked'),null);
  storage.setItem('sonos-library-views-v1','{broken');assert.equal(views.read('a','liked'),null);
  const blocked=createLibraryViewStore({getItem(){throw Error();},setItem(){throw Error();},removeItem(){throw Error();}});
  assert.doesNotThrow(()=>{blocked.write('a','liked',{query:'',visible:60,top:0});blocked.clear();});assert.equal(blocked.read('a','liked'),null);
});
