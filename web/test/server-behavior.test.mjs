import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {replaceQueueSafely} from '../queue-safety.mjs';
const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
const install=(c,from,to)=>vm.runInContext(source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from))),c);

test('queue playback switches from radio to the selected coordinator queue before seeking',async()=>{
  const actions=[];
  const c=vm.createContext({soap:async(service,action,args,target)=>{actions.push({action,args,target});return 'radio';},tag:xml=>xml});
  install(c,'async function activateQueue(', 'async function playSong(');
  await c.activateQueue('speaker-B','RINCON_B',4);
  assert.deepEqual(actions.map(x=>x.action),['GetMediaInfo','SetAVTransportURI','Seek','Play']);
  assert.equal(actions[1].args.CurrentURI,'x-rincon-queue:RINCON_B#0');
  assert.equal(actions[2].args.Target,4);assert.ok(actions.every(x=>x.target==='speaker-B'));
});

test('an already active queue is not reset before selecting another song',async()=>{
  const actions=[];
  const c=vm.createContext({soap:async(_,action)=>{actions.push(action);return 'x-rincon-queue:RINCON_A#0';},tag:xml=>xml});
  install(c,'async function activateQueue(', 'async function playSong(');
  await c.activateQueue('speaker-A','RINCON_A',7);
  assert.deepEqual(actions,['GetMediaInfo','Seek','Play']);
});

test('QQ playback context reads favorites from the selected speaker rather than the default',async()=>{
  const targets=[];
  const c=vm.createContext({browse:async(id,start,count,target)=>{targets.push(target);return {xml:''};},items:()=>[],tag:()=> 'x-sonos-http:SONG:11:ST.mp4?sid=23&sn=4',soap:async()=>''});
  install(c,'async function qqQueueContext(', 'async function enqueueSong(');
  assert.equal((await c.qqQueueContext('speaker-B')).sn,'4');assert.deepEqual(targets,['speaker-B']);
});

function importHarness(job){
  const songs=[1,2,3].map((id,i)=>({id,mid:`song-${id}`,index:i+1,title:`Song ${id}`}));
  const actions=[],plans=[],queueImports=new Map(job?[['speaker',job]]:[]);
  const c=vm.createContext({playlist:async()=>({id:'liked',account:'account-a',songs,title:'Example'}),coordinator:async()=>({target:'speaker',coordinatorId:'RINCON_A'}),
    selectedPlaylistId:'liked',queueImports,shuffleModes:new Map(),withQueueMutation:async(_,fn)=>fn(),historyAccount:()=> 'account-a',
    matchingPlaylistOrder:async()=>null,browse:async(id,start)=>({total:job?.added||1,updateId:'1',xml:`${start+1}`}),items:xml=>[xml],songIdFromItem:item=>Number(item),
    requiresQueueRecheck:()=>false,activateQueue:async(...args)=>actions.push(['activate',...args]),
    qqQueueContext:async()=>({sid:'23',sn:'1'}),tag:(_,name)=>name==='PlayMode'?'NORMAL':'',soap:async(_,action)=>{actions.push([action]);return '';},
    replaceQueueSafely:async({append,play})=>{await append();await play(2);},enqueueSong:async()=>2,confirmQueuePlayback:async()=>{},
    finishQueueImport:(target,job,list,context,plan)=>plans.push(plan),visibleQueueImport:job=>({phase:job.phase}),
    remainingPlaylistIndices:()=>[],shuffledIndices:x=>x,withoutSonosShuffle:x=>x});
  install(c,'async function startPlaylistPlayback(', 'async function rebuildManagedTail(');
  return {c,actions,plans};
}

test('selecting an imported song reuses the existing playlist queue',async()=>{
  const job={phase:'complete',playlistId:'liked',account:'account-a',order:[0,1,2],added:3,total:3,queueUpdateId:'1'};
  const {c,actions,plans}=importHarness(job);
  await c.startPlaylistPlayback({playlistId:'liked',index:2,mid:'song-2'},'A');
  assert.equal(actions[0][0],'activate');assert.equal(actions[0][3],2);assert.equal(plans.length,0);
});

test('a new choice outside the imported prefix cancels old work and begins with that song',async()=>{
  const job={phase:'building',playlistId:'liked',account:'account-a',order:[0],added:1,total:3};
  const {c,plans}=importHarness(job);
  const result=await c.startPlaylistPlayback({playlistId:'liked',index:3,mid:'song-3'},'A');
  assert.equal(job.cancelled,true);assert.equal(result.title,'Song 3');
  assert.deepEqual(Array.from(c.queueImports.get('speaker').order),[2]);assert.equal(plans.length,1);
});

test('concurrent session updates persist valid JSON with restrictive file permissions',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sonos-session-test-'));
  try{
    const moduleUrl=new URL('../qq-session.mjs',import.meta.url).href;
    const script=`import {saveSession,saveSelectedPlaylist} from ${JSON.stringify(moduleUrl)};
      import {readFile,stat} from 'node:fs/promises';
      await Promise.all(Array.from({length:12},(_,i)=>saveSession('uin='+String(10000+i)+'; qm_keyst=test-fixture')));
      await Promise.all([saveSelectedPlaylist('123'),saveSelectedPlaylist('456')]);
      const p=process.env.SONOS_DATA_DIR+'/.qq-session.json';const saved=JSON.parse(await readFile(p,'utf8'));
      console.log(JSON.stringify({count:Object.keys(saved.accounts).length,selected:saved.selectedPlaylists[saved.active],mode:(await stat(p)).mode&511}));`;
    const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:{...process.env,SONOS_DATA_DIR:directory}});
    assert.deepEqual(JSON.parse(stdout),{count:12,selected:'456',mode:0o600});
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('missing artwork never waits for the entire QQ playlist before returning transport status',async()=>{
  let playlistReads=0;
  const c=vm.createContext({URL,coordinator:async()=>({target:'http://speaker:1400',device:'http://speaker:1400',room:'Example',roomId:'A',groupSize:1}),
    soap:async(_,action)=>action,tag:(_,name)=>({TrackURI:'x-sonos-http:SONG:1:ST.mp4',CurrentTransportState:'PLAYING',RelTime:'0:00:20',TrackDuration:'0:04:00'})[name]||'',
    cached:null,searchedSongById:()=>null,songDetailCache:new Map(),warmSongDetails(){},playlist:()=>{playlistReads++;return new Promise(()=>{});},shuffleModes:new Map()});
  install(c,'async function status(', 'async function control(');
  const result=await c.status('A');assert.equal(result.playing,true);assert.equal(result.position,'0:00:20');assert.equal(playlistReads,0);
});

 test('an old playlist request waiting for the queue cannot import after account switching',async()=>{
  const {c,actions,plans}=importHarness();let run;
  c.withQueueMutation=async(_,fn)=>{run=fn;};
  await c.startPlaylistPlayback({playlistId:'liked',index:1,mid:'song-1'},'A');
  c.historyAccount=()=> 'account-b';
  await assert.rejects(run(),/账号或歌单已切换/);
  assert.equal(actions.length,0);assert.equal(plans.length,0);
});

test('background song details coalesce requests and release the slot after failure',async()=>{
  let reject,calls=0;
  const c=vm.createContext({albumMidLoads:new Map(),qqAlbumMid:()=>{calls++;return new Promise((_,r)=>{reject=r;});}});
  install(c,'function warmSongDetails(', 'function parseLyrics(');
  c.warmSongDetails(1);c.warmSongDetails(1);assert.equal(calls,1);
  reject(Error('QQ unavailable'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.albumMidLoads.size,0);
  c.qqAlbumMid=async()=>'';c.warmSongDetails(1);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.albumMidLoads.size,0);
});

test('background details retain track metadata without loading a playlist',async()=>{
  const detail={id:1,mid:'sample',title:'Example (Live)',singer:[{name:'Artist'}],album:{mid:'abcdefghijklmn',name:'Album'},interval:240};
  const c=vm.createContext({URL,URLSearchParams,AbortSignal,albumMidCache:new Map(),songDetailCache:new Map(),fetch:async()=>({ok:true,json:async()=>({data:[detail]})})});
  install(c,'const mapSong=', 'async function playlist(refresh=');
  install(c,'async function qqAlbumMid(', 'function warmSongDetails(');
  assert.equal(await c.qqAlbumMid(1),'abcdefghijklmn');
  assert.equal(c.songDetailCache.get(1).title,'Example (Live)');assert.equal(c.songDetailCache.get(1).duration,240);
});

test('play on an empty speaker queue explains how to begin without issuing Play',async()=>{
  const actions=[];
  const c=vm.createContext({soap:async(_,action)=>{actions.push(action);return '';},tag:()=>'',browse:async()=>({total:0}),activateQueue:()=>assert.fail('must not activate an empty queue')});
  install(c,'async function resumePlayback(', 'async function control(');
  await assert.rejects(c.resumePlayback('speaker','RINCON_A'),/队列为空.*歌单/);
  assert.deepEqual(actions,['GetMediaInfo']);
});

test('play activates the first queued song if the speaker has no selected source',async()=>{
  const activated=[];
  const c=vm.createContext({soap:async()=>'',tag:()=>'',browse:async()=>({total:3}),activateQueue:async(...args)=>activated.push(args)});
  install(c,'async function resumePlayback(', 'async function control(');
  await c.resumePlayback('speaker-B','RINCON_B');assert.deepEqual(activated,[['speaker-B','RINCON_B',1]]);
});

test('resume preserves the selected queue song and allows continuous radio streams',async()=>{
  for(const uri of ['x-rincon-queue:RINCON_A#0','x-sonosapi-stream:example']){
    const actions=[];
    const c=vm.createContext({soap:async(_,action)=>{actions.push(action);return '';},tag:(_,name)=>name==='CurrentURI'?uri:name==='NrTracks'?(uri.startsWith('x-rincon-queue:')?'5':'0'):'',browse:()=>assert.fail('must preserve selected source'),activateQueue:()=>assert.fail('must not reset selected song')});
    install(c,'async function resumePlayback(', 'async function control(');
    await c.resumePlayback('speaker','RINCON_A');assert.deepEqual(actions,['GetMediaInfo','Play']);
  }
});

test('an emptied active queue is rejected before sending an invalid Play command',async()=>{
  const c=vm.createContext({soap:async()=>'',tag:(_,name)=>name==='CurrentURI'?'x-rincon-queue:RINCON_A#0':'0',browse:async()=>({total:0})});
  install(c,'async function resumePlayback(', 'async function control(');
  await assert.rejects(c.resumePlayback('speaker','RINCON_A'),/队列为空/);
});
