import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createOperationTracker} from '../public/transport-sync.mjs';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

function harness(){
  const elements=new Map();
  function element(id){
    if(!elements.has(id)){
      const listeners=new Map(),classes=new Set(),properties=new Map();
      elements.set(id,{id,value:'20',max:'100',textContent:'',hidden:false,disabled:false,open:true,children:[],dataset:{},options:[],
        style:{setProperty:(k,v)=>properties.set(k,v),removeProperty:k=>properties.delete(k)},
        classList:{add:(...v)=>v.forEach(x=>classes.add(x)),remove:(...v)=>v.forEach(x=>classes.delete(x)),contains:x=>classes.has(x),toggle:(k,on)=>on?classes.add(k):classes.delete(k)},
        addEventListener(type,fn){listeners.set(type,[...(listeners.get(type)||[]),fn]);},
        emit(type,event={}){for(const fn of listeners.get(type)||[])fn({target:this,preventDefault(){},...event});},
        close(){this.open=false;this.emit('close');},
        querySelectorAll(){return [];},replaceChildren(...v){this.children=v;},setAttribute(){},removeAttribute(){},
        getBoundingClientRect(){return {left:0,width:200,top:0,right:200,bottom:200};},setPointerCapture(){},closest(){return null;},scrollTop:0
      });
    }
    return elements.get(id);
  }
  const context=vm.createContext({URL,AbortSignal,console,Date,performance:{now:()=>100},
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,requestAnimationFrame:fn=>fn(),
    matchMedia:()=>({matches:true}),window:{addEventListener(){}},document:{activeElement:null},
    localStorage:{getItem:()=>null,setItem(){}},$:element,roomGeneration:0,selectedRoomId:'A',
    songActionGeneration:0,queueActionGeneration:0,lastStatusAt:0,statusFailed:false,renderConnectionFeedback(){},updateProgress(){},quickSearchComposing:false,quickSearchMoreFailed:false,libraryViewActive:()=>true,restoreLibraryView(){},libraryPlaylistId:'liked',libraryRestore:null,restoringLibrary:false,rememberLibraryView(){},libraryViews:{read:()=>null},
    statusInFlight:null,pendingModes:new Map(),modeGeneration:0,livePosition:()=>0,statusRequest:0,playRequestGeneration:0,shuffleGeneration:0,pendingShuffleValue:null,
    expectedPlaying:null,transportExpectation:null,transportSettlingUntil:0,transportOperations:createOperationTracker(),
    currentStatus:{playing:false},positionAnchor:{},lyricTrack:'',lyrics:[],volumeDesired:null,volumeSending:false,
    groupDesired:null,groupSending:false,volumeDragging:false,seeking:false,queueRequest:0,queueLoading:false,chosenQueueTrack:null,
    sleepRequest:0,sleepSending:false,sleepWriteGeneration:0,sleepEndsAt:null,historyRequest:0,libraryAccount:'a',
    renders:[],toasts:[],renderStatus(s){context.currentStatus=s;context.renders.push(s);},renderSleep(){},
    toast(message){context.toasts.push(message);},paintRange(){},updateStatus:async()=>null,
    api:async()=>({}),beginTransportSync:()=>context.transportOperations.begin(),settleTransport:async()=>true,
    createSongRow:s=>s,guardVolumeTrack(){},showVolume(){},duration:n=>String(n)});
  const install=(from,to)=>vm.runInContext(source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from))),context);
  return {context,element,install};
}

test('room storage access may throw without preventing initialization',()=>{
  const c=vm.createContext({createPlaylistCache:()=>({})});
  Object.defineProperty(c,'localStorage',{get(){throw Error('Storage blocked');}});
  const prefix=source.replace(/^import .*;\n/gm,'').split("let libraryAccount=")[0];
  assert.doesNotThrow(()=>vm.runInContext(prefix,c));
  assert.equal(vm.runInContext('selectedRoomId',c),'');
});

test('status from the previous room cannot replace the newly selected room',async()=>{
  const {context:c,install}=harness(),old=deferred(),fresh=deferred();
  install('function selectRoom(', 'let roomsRequest=');
  install('async function updateStatus(', 'async function settleTransport(');
  let calls=0;c.api=()=>++calls===1?old.promise:fresh.promise;
  const a=c.updateStatus();c.selectRoom('B');const b=c.updateStatus();
  fresh.resolve({roomId:'B',playing:true});await b;
  old.resolve({roomId:'A',playing:false});await a;
  assert.equal(c.renders.length,1);assert.equal(c.currentStatus.roomId,'B');
});

test('switching away and back invalidates old control errors and transport expectations',async()=>{
  const {context:c,install}=harness(),command=deferred();
  install('function selectRoom(', 'let roomsRequest=');
  install('async function control(action,value)', 'async function sendVolume(');
  c.api=()=>command.promise;
  const old=c.control('pause');c.selectRoom('B');c.selectRoom('A');
  c.expectedPlaying=true;c.transportExpectation={playing:true};
  command.reject(Error('old room failed'));await old;
  assert.equal(c.expectedPlaying,true);assert.equal(c.toasts.length,0);
});

test('a queued volume write retains its original room and never drains into another room',async()=>{
  const {context:c,install}=harness(),gate=deferred(),calls=[];
  install('async function sendVolume(', 'function guardVolumeTrack(');
  c.api=(url,options)=>{calls.push([url,JSON.parse(options.body).value]);return gate.promise;};
  c.queueVolume(12);c.queueVolume(15);
  c.roomGeneration++;c.selectedRoomId='B';
  gate.resolve({});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[['/api/control?room=A',12]]);
});

test('history replies are ignored after the account changes',async()=>{
  const {context:c,element,install}=harness(),reply=deferred();
  install('let historyRequest=', 'function showLibraryView(');
  c.api=()=>reply.promise;
  const old=c.loadHistory();c.libraryAccount='b';
  reply.resolve({songs:[{title:'Account A song'}]});await old;
  assert.equal(element('history-list').children.length,0);
});

test('timer write supersedes an old status read and blocks duplicate submission',async()=>{
  const {context:c,install}=harness(),read=deferred(),write=deferred();
  install('async function loadSleep(', "$('sleep-open').onclick");
  const renders=[];c.renderSleep=()=>renders.push(c.sleepEndsAt);
  let posts=0;c.api=(_,options)=>options?(posts++,write.promise):read.promise;
  const reading=c.loadSleep();const setting=c.setSleep({mode:'minutes',minutes:30});
  await c.setSleep({mode:'minutes',minutes:40});assert.equal(posts,1);
  write.resolve({endsAt:'2030-01-01T12:00:00Z'});await setting;
  read.resolve({endsAt:null});await reading;
  assert.deepEqual(renders,[Date.parse('2030-01-01T12:00:00Z')]);
});

test('timer errors from an old room cannot change the selected room display',async()=>{
  const {context:c,element,install}=harness(),reply=deferred();
  install('async function loadSleep(', "$('sleep-open').onclick");
  c.api=()=>reply.promise;const loading=c.loadSleep();c.roomGeneration++;
  element('sleep-state').textContent='New room';
  reply.reject(Error('Old room offline'));await loading;
  assert.equal(element('sleep-state').textContent,'New room');assert.equal(c.toasts.length,0);
});

test('canceling or releasing a seek without change never freezes progress updates',()=>{
  for(const type of ['pointerup','pointercancel','lostpointercapture','blur']){
    const {context:c,element,install}=harness();
    install('function bindPlayer(prefix)', "bindPlayer('');");c.bindPlayer('');
    element('seek').emit('pointerdown');assert.equal(c.seeking,true);
    element('seek').emit(type);assert.equal(c.seeking,false);
  }
});

test('volume track rejects remote taps, caps upward drag, and handles lost capture',()=>{
  const {context:c,element,install}=harness(),values=[];
  install('function guardVolumeTrack(', 'function bindPlayer(');
  const slider=element('volume'),track=element('track');slider.parentElement=track;
  c.guardVolumeTrack(slider,value=>{slider.value=String(value);values.push(value);});
  track.emit('pointerdown',{button:0,pointerId:1,clientX:180});
  track.emit('pointermove',{pointerId:1,clientX:190});assert.deepEqual(values,[]);
  track.emit('pointerdown',{button:0,pointerId:1,clientX:46});
  track.emit('pointermove',{pointerId:1,clientX:190});assert.deepEqual(values,[30]);
  track.emit('lostpointercapture',{pointerId:1});assert.equal(c.volumeDragging,false);
  track.emit('pointermove',{pointerId:1,clientX:190});assert.equal(values.length,1);
});

test('canceled swipe and backdrop drag cannot dismiss a sheet',()=>{
  const {context:c,element,install}=harness();
  install('function bindSwipeToDismiss(', "bindSwipeToDismiss('queue-dialog')");
  const target=element('content'),sheet=element('queue-dialog');
  c.bindSwipeToDismiss('queue-dialog');
  sheet.emit('touchstart',{target,touches:[{clientX:50,clientY:10}]});
  sheet.emit('touchmove',{target,touches:[{clientX:50,clientY:130}]});
  assert.equal(sheet.classList.contains('sheet-dragging'),true);
  sheet.emit('touchcancel');
  assert.equal(sheet.open,true);assert.equal(sheet.classList.contains('sheet-dragging'),false);
  sheet.emit('touchstart',{target:sheet,touches:[{clientX:50,clientY:-120}]});
  sheet.emit('touchmove',{touches:[{clientX:50,clientY:10}]});sheet.emit('touchend');
  assert.equal(sheet.open,true);
  // A deliberate content swipe remains available.
  sheet.emit('touchstart',{target,touches:[{clientX:50,clientY:10}]});
  sheet.emit('touchmove',{target,touches:[{clientX:50,clientY:130}]});sheet.emit('touchend');
  assert.equal(sheet.open,false);
});

 test('room-specific history recording and read/write deadlines reach fetch',async()=>{
  const {context:c,install}=harness(),requests=[];
  c.location={href:'http://localhost/'};
  c.fetch=async(url,options)=>{requests.push([String(url),options]);return {ok:true,json:async()=>({ok:true})};};
  install('async function api(', 'function paintRange(');
  await c.api('/api/history/record',{method:'POST',body:'{}'});
  assert.equal(new URL(requests[0][0]).searchParams.get('room'),'A');
  assert.ok(requests[0][1].signal instanceof AbortSignal);
});

test('slow polling shares an in-flight status read rather than starving every response',async()=>{
  const {context:c,install}=harness(),reply=deferred();let calls=0;
  install('async function updateStatus(', 'async function settleTransport(');
  c.api=()=>{calls++;return reply.promise;};
  const reads=[c.updateStatus(),c.updateStatus(),c.updateStatus()];
  assert.equal(calls,1);reply.resolve({playing:true,roomId:'A'});await Promise.all(reads);
  assert.equal(c.renders.length,1);assert.equal(c.statusInFlight,null);
});

test('a new command invalidates an old poll without sharing its stale promise',async()=>{
  const {context:c,install}=harness(),old=deferred(),fresh=deferred();let calls=0;
  install('async function updateStatus(', 'async function settleTransport(');
  c.api=()=>++calls===1?old.promise:fresh.promise;
  const a=c.updateStatus();c.statusRequest++;const b=c.updateStatus();
  fresh.resolve({playing:true});await b;old.resolve({playing:false});await a;
  assert.equal(c.currentStatus.playing,true);assert.equal(c.renders.length,1);
});

test('a failed volume write in an old room does not drop a new room adjustment',async()=>{
  const {context:c,install}=harness(),old=deferred(),calls=[];
  install('async function sendVolume(', 'function guardVolumeTrack(');
  c.api=(url,options)=>{calls.push([url,JSON.parse(options.body).value]);return calls.length===1?old.promise:Promise.resolve({});};
  c.queueVolume(12);c.roomGeneration++;c.selectedRoomId='B';c.queueVolume(9);
  old.reject(Error('old room offline'));await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[['/api/control?room=A',12],['/api/control?room=B',9]]);
  assert.equal(c.toasts.length,0);
});

test('mute and repeat updates are immediate and stale status cannot undo pending values',async()=>{
  const {context:c,install}=harness(),command=deferred();
  install('async function control(action,value)', 'async function sendVolume(');
  c.api=()=>command.promise;c.currentStatus={playing:true,mute:false,repeatAll:true,repeatOne:false};
  const setting=c.control('repeatOne',true);
  assert.equal(c.currentStatus.repeatOne,true);assert.equal(c.currentStatus.repeatAll,false);
  c.api=async()=>({playing:true,repeatOne:false,repeatAll:true});
  install('async function updateStatus(', 'async function settleTransport(');
  await c.updateStatus();assert.equal(c.currentStatus.repeatOne,true);
  command.resolve({});await setting;
});

test('a stale mute failure cannot clear a newer mute operation',async()=>{
  const {context:c,install}=harness(),first=deferred(),second=deferred();let calls=0;
  install('async function control(action,value)', 'async function sendVolume(');
  c.api=()=>++calls===1?first.promise:second.promise;
  const a=c.control('mute',true);assert.equal(c.currentStatus.mute,true);
  const b=c.control('mute',false);assert.equal(c.currentStatus.mute,false);
  first.reject(Error('first failed'));await a;
  assert.equal(c.pendingModes.get('mute').value,false);
  second.resolve({});await b;
});

test('minutes input validates locally and Enter uses the minutes field',async()=>{
  const {context:c,element,install}=harness(),sent=[];
  c.document.querySelector=()=>({click(){}});
  install("$('sleep-form').noValidate=true;", "$('sleep-cancel').onclick");
  c.setSleep=input=>sent.push(input);
  element('sleep-minutes').value='0';
  element('sleep-form').onsubmit({preventDefault(){},submitter:{value:'minutes'}});
  assert.equal(sent.length,0);assert.match(c.toasts[0],/1 到 1440/);
  element('sleep-minutes').value='30';c.document.activeElement=element('sleep-minutes');
  element('sleep-form').onsubmit({preventDefault(){}});
  assert.equal(sent[0].mode,'minutes');assert.equal(sent[0].minutes,30);
});

test('a late queue page cannot replace a newer room queue',async()=>{
  const {context:c,element,install}=harness(),reply=deferred();
  c.document.createDocumentFragment=()=>({append(){}});
  install('async function loadQueue(', 'function markCurrentQueueTrack(');
  c.api=()=>reply.promise;c.markCurrentQueueTrack=()=>{};
  const a=c.loadQueue();c.roomGeneration++;c.queueRequest++;
  element('queue-state').textContent='New room';reply.resolve({start:0,total:0,tracks:[]});await a;
  assert.equal(element('queue-state').textContent,'New room');
});

test('closing login before the QR request finishes cannot restart polling',async()=>{
  const {context:c,element,install}=harness(),reply=deferred();let intervals=0;
  c.clearInterval=()=>{};c.setInterval=()=>{intervals++;return 1;};c.qrTimer=null;
  install('let qrGeneration=', 'function syncVisualViewport(');
  c.api=()=>reply.promise;const opening=c.startQr();
  element('login-dialog').open=false;c.stopQr();reply.resolve({image:'test-image'});await opening;
  assert.equal(intervals,0);assert.equal(element('qr-image').hidden,true);
});

test('QR polling is single flight and an obsolete result cannot close a new login',async()=>{
  const {context:c,element,install}=harness(),reply=deferred();let calls=0;
  c.clearInterval=()=>{};c.qrTimer=null;
  install('let qrGeneration=', 'function syncVisualViewport(');
  c.api=()=>{calls++;return reply.promise;};
  const polling=c.pollQr();await c.pollQr();assert.equal(calls,1);
  c.stopQr();reply.resolve({state:'connected'});await polling;
  assert.equal(element('login-dialog').open,true);assert.equal(c.toasts.length,0);
});

test('request timeouts explain uncertain writes without automatically retrying them',async()=>{
  const {context:c,install}=harness();let requests=0;
  c.location={href:'http://localhost/'};c.fetch=async()=>{requests++;throw new DOMException('expired','TimeoutError');};
  install('async function api(', 'function paintRange(');
  await assert.rejects(c.api('/api/control',{method:'POST',body:'{}'}),/可能已到达音箱/);
  assert.equal(requests,1);
  await assert.rejects(c.api('/api/status'),/检查网络/);
});

 test('the sheet grabber remains draggable even though its pseudo-element targets the dialog',()=>{
  const {context:c,element,install}=harness();
  install('function bindSwipeToDismiss(', "bindSwipeToDismiss('queue-dialog')");
  const sheet=element('queue-dialog');c.bindSwipeToDismiss('queue-dialog');
  sheet.emit('touchstart',{target:sheet,touches:[{clientX:50,clientY:10}]});
  sheet.emit('touchmove',{target:sheet,touches:[{clientX:50,clientY:130}]});sheet.emit('touchend');
  assert.equal(sheet.open,false);
});

test('a coincidentally matching old mode report cannot confirm an unacknowledged command',async()=>{
  const {context:c,install}=harness(),command=deferred();
  install('async function control(action,value)', 'async function sendVolume(');
  c.api=()=>command.promise;const setting=c.control('mute',false);
  c.api=async()=>({playing:true,mute:false});
  install('async function updateStatus(', 'async function settleTransport(');
  await c.updateStatus();assert.equal(c.pendingModes.has('mute'),true);
  command.resolve({});await setting;assert.equal(c.pendingModes.has('mute'),false);
});

test('a timer write in another room neither blocks nor unlocks the new room submission',async()=>{
  const {context:c,install}=harness(),old=deferred(),fresh=deferred();let calls=0;
  install('function selectRoom(', 'let roomsRequest=');
  install('async function loadSleep(', "$('sleep-open').onclick");
  c.api=()=>++calls===1?old.promise:fresh.promise;
  const a=c.setSleep({mode:'minutes',minutes:10});c.selectRoom('B');
  const b=c.setSleep({mode:'minutes',minutes:20});assert.equal(calls,2);
  old.resolve({endsAt:null});await a;assert.equal(c.sleepSending,true);
  fresh.resolve({endsAt:'2030-01-01T00:00:00Z'});await b;assert.equal(c.sleepSending,false);
});

test('changing a search query blocks pagination until its first page is ready',async()=>{
  const {context:c,element,install}=harness();let requests=0;
  Object.assign(c,{quickSearchRequest:1,quickSearchPage:1,quickSearchLoading:false,quickSearchTimer:null,renderQuickResults(){}});
  c.api=async()=>{requests++;return {};};element('quick-search').value='new query';
  install('async function loadMoreQuickResults(', 'function scheduleQuickSearch(');
  install('function scheduleQuickSearch(', "$('quick-search-more').onclick");
  c.scheduleQuickSearch();await c.loadMoreQuickResults();
  assert.equal(element('quick-search-more').disabled,true);assert.equal(requests,0);
});

test('a queue click reports when the speaker never confirms playback',async()=>{
  const {context:c,element,install}=harness();let created=0;
  c.document.createElement=()=>{const e=element(`generated-${created++}`);e.append=(...v)=>e.children.push(...v);e.blur=()=>{};return e;};
  c.document.createDocumentFragment=()=>({children:[],append(...v){this.children.push(...v);}});
  c.api=async(url)=>url.startsWith('/api/queue?')?{start:0,total:1,tracks:[{number:1,title:'Example',artist:'Artist',key:'fingerprint'}]}:{};
  c.markCurrentQueueTrack=()=>{};c.settleTransport=async()=>false;
  install('async function loadQueue(', 'function markCurrentQueueTrack(');
  await c.loadQueue();
  const row=element('queue-list').children[0].children[0].children[0];
  await row.onclick();assert.match(c.toasts[0],/尚未确认播放/);assert.equal(row.disabled,false);
});

test('a drag starting on protected group volume cannot dismiss the room sheet',()=>{
  const {context:c,element,install}=harness();
  install('function bindSwipeToDismiss(', "bindSwipeToDismiss('queue-dialog')");
  const sheet=element('rooms-dialog'),track=element('protected-volume');
  track.closest=selector=>selector.includes('.safe-volume-track')?track:null;
  c.bindSwipeToDismiss('rooms-dialog');
  sheet.emit('touchstart',{target:track,touches:[{clientX:50,clientY:10}]});
  sheet.emit('touchmove',{target:track,touches:[{clientX:50,clientY:130}]});sheet.emit('touchend');
  assert.equal(sheet.open,true);assert.equal(sheet.classList.contains('sheet-dragging'),false);
});

test('reopening search preserves its query and does not erase existing results',()=>{
  const {context:c,element,install}=harness();let searches=0,focused=0;
  Object.assign(c,{quickSearchInitialized:true,quickSearchTimer:null,showDialog(){},updateMiniVisibility(){},renderQuickResults(){searches++;}});
  element('quick-search').value='example';element('quick-search').focus=()=>focused++;
  install('function openCatalogSearch(', "$('quick-search-open').onclick");
  c.openCatalogSearch({detail:1});assert.equal(element('quick-search').value,'example');assert.equal(searches,0);assert.equal(focused,0);
  element('quick-search-clear').onclick();assert.equal(element('quick-search').value,'');assert.equal(searches,1);assert.equal(focused,1);
});

test('more controls opened from queue can return to the same queue page',()=>{
  const {context:c,element,install}=harness(),pages=[];
  Object.assign(c,{queueStart:100,showDialog:id=>{element(id).open=true;},updateMiniVisibility(){},loadQueue:page=>pages.push(page)});
  install("let utilitiesReturnTo=", "$('repeat-all').onclick");
  element('queue-dialog').open=true;element('utilities-dialog').open=false;
  element('queue-utilities-open').onclick({detail:1});assert.equal(element('queue-dialog').open,false);assert.equal(element('utilities-dialog').open,true);assert.equal(element('utilities-back').hidden,false);
  element('utilities-back').onclick({detail:1});assert.equal(element('queue-dialog').open,true);assert.deepEqual(pages,[100]);
});

test('timer write failures remain inline and leave submit available for retry',async()=>{
  const {context:c,element,install}=harness();
  install('async function loadSleep(', "$('sleep-open').onclick");
  c.api=async()=>{throw Error('Network unavailable');};await c.setSleep({mode:'minutes',minutes:15});
  assert.match(element('sleep-feedback').textContent,/设置失败.*Network unavailable/);assert.equal(element('sleep-feedback').hidden,false);assert.equal(c.sleepSending,false);
  c.api=async()=>({endsAt:'2030-01-01T00:00:00Z'});await c.setSleep({mode:'minutes',minutes:15});
  assert.equal(element('sleep-feedback').classList.contains('error'),false);assert.match(element('sleep-feedback').textContent,/已设置/);
});

test('refresh targets the visible library view and blocks duplicate requests',async()=>{
  const {context:c,element,install}=harness(),pending=deferred(),calls=[];
  Object.assign(c,{loadHistory:()=>{calls.push('history');return pending.promise;},loadCatalog:async()=>calls.push('catalog'),loadPlaylist:async()=>calls.push('playlist')});
  install('async function refreshLibrary(', "$('refresh').onclick");
  element('history-panel').hidden=false;
  const first=c.refreshLibrary();await c.refreshLibrary();assert.deepEqual(calls,['history']);
  assert.equal(element('refresh').disabled,true);pending.resolve();await first;
  assert.equal(element('refresh').disabled,false);
  element('history-panel').hidden=true;await c.refreshLibrary();assert.deepEqual(calls,['history','catalog','playlist']);
});

test('library tabs expose refresh labels matching the selected view',()=>{
  const {context:c,element,install}=harness(),labels=[];
  Object.assign(c,{locateGeneration:0,markCurrentPlaylistSong(){},loadHistory(){}});
  element('refresh').setAttribute=(name,value)=>{if(name==='aria-label')labels.push(value);};
  install('function showLibraryView(', "$('history-clear').onclick");
  c.showLibraryView('history');assert.equal(element('refresh-label').textContent,'刷新最近播放');
  c.showLibraryView('playlist');assert.equal(element('refresh-label').textContent,'刷新歌单');
  assert.deepEqual(labels,['刷新最近播放','刷新歌单']);
});

test('unloaded and empty playlists have different guidance',()=>{
  const {context:c,element,install}=harness();
  Object.assign(c,{songs:[],visible:60,filtered:[],displayedPlaylistId:'',markCurrentPlaylistSong(){}});
  c.document.createDocumentFragment=()=>({append(){}});
  element('song-list').append=()=>{};element('song-list').childElementCount=0;element('search').value='';
  install('function renderSongs(', 'function markCurrentPlaylistSong(');
  c.renderSongs();assert.equal(element('list-state').textContent,'正在加载歌单…');
  c.displayedPlaylistId='empty';c.renderSongs();assert.match(element('list-state').textContent,/没有歌曲.*切换其他歌单/);
  c.libraryAccount='';c.renderSongs();assert.match(element('list-state').textContent,/登录 QQ 音乐/);
});

test('Chinese composition invalidates old searches without starting a partial query',()=>{
  const {context:c,install}=harness();let scheduled=0;
  Object.assign(c,{quickSearchRequest:4,quickSearchTimer:1,quickSearchComposing:true,renderQuickResults(){},setTimeout(){scheduled++;}});
  install('function scheduleQuickSearch(', "$('quick-search-more').onclick");
  c.scheduleQuickSearch();assert.equal(c.quickSearchRequest,5);assert.equal(scheduled,0);
  c.quickSearchComposing=false;c.scheduleQuickSearch();assert.equal(scheduled,1);
});
test('progress extrapolation stops when no fresh status has arrived for fifteen seconds',()=>{
  const {context:c,install}=harness();
  Object.assign(c,{currentStatus:{duration:'4:00'},positionAnchor:{seconds:20,at:1000,playing:true},lastStatusAt:1000,Date:{now:()=>31000},timecode:()=>240});
  install('function livePosition(', 'function renderOptimisticTransport(');
  assert.equal(c.livePosition(),35);
});
test('connection feedback distinguishes optimistic confirmation, stale state and disconnection',()=>{
  const {context:c,element,install}=harness();
  Object.assign(c,{currentStatus:{room:'Demo'},lastStatusAt:1000,Date:{now:()=>2000}});
  install('function renderConnectionFeedback(', 'function updateProgress(');
  c.expectedPlaying=true;c.renderConnectionFeedback();assert.match(element('player-room-name').textContent,/正在确认/);
  c.expectedPlaying=null;c.renderConnectionFeedback();assert.match(element('connection').textContent,/已连接/);
  c.Date.now=()=>20000;c.renderConnectionFeedback();assert.match(element('queue-room-name').textContent,/正在重连/);
  c.statusFailed=true;c.renderConnectionFeedback();assert.match(element('connection').textContent,/连接中断/);
});
test('browse restoration batches large lists and cancels before changing scroll after user input',()=>{
  const {context:c,install}=harness(),frames=[],scrolls=[];
  Object.assign(c,{locateGeneration:1,filtered:Array(1000),visible:60,restoringLibrary:false,requestAnimationFrame:fn=>frames.push(fn),renderSongs(){},window:{scrollTo:options=>scrolls.push(options)}});
  install('function restoreLibraryView(', 'function displayPlaylist(');
  c.restoreLibraryView({visible:780,top:2500});frames.shift()();assert.equal(c.visible,300);
  c.locateGeneration++;while(frames.length)frames.shift()();assert.equal(scrolls.length,0);
  c.restoreLibraryView({visible:780,top:2500});while(frames.length)frames.shift()();assert.equal(c.visible,780);assert.equal(scrolls[0].top,2500);
});

test('a search reply for the previous account cannot populate the new account view',async()=>{
  const {context:c,element,install}=harness(),reply=deferred();
  Object.assign(c,{quickSearchRequest:0,quickSearchInitialized:false,quickSearchPage:0,quickSearchLoading:false,
    queryCache:{load:()=>reply.promise},appendQuickResults(){throw Error('stale result was rendered');}});
  element('quick-search').value='Example';
  install('async function renderQuickResults(', 'async function loadMoreQuickResults(');
  const pending=c.renderQuickResults();c.libraryAccount='b';reply.resolve({songs:[{title:'Old account result'}]});await pending;
  assert.equal(c.quickSearchPage,0);
});

test('an obsolete browse restoration cannot release a newer restoration guard',()=>{
  const {context:c,install}=harness(),frames=[];
  Object.assign(c,{locateGeneration:1,filtered:Array(1000),visible:60,restoringLibrary:false,requestAnimationFrame:fn=>frames.push(fn),renderSongs(){},window:{scrollTo(){}}});
  install('function restoreLibraryView(', 'function displayPlaylist(');
  c.restoreLibraryView({visible:780,top:2500});c.locateGeneration++;
  c.restoreLibraryView({visible:300,top:1000});const latest=c.restoringLibrary;
  frames.shift()();assert.equal(c.restoringLibrary,latest);
  while(frames.length)frames.shift()();assert.equal(c.restoringLibrary,false);
});

test('a failed status read freezes the last estimated position and immediately repaints progress',async()=>{
  const {context:c,install}=harness();let updates=0;
  Object.assign(c,{livePosition:()=>42,updateProgress(){updates++;},api:async()=>{throw Error('offline');}});
  install('async function updateStatus(', 'async function settleTransport(');
  await c.updateStatus();assert.equal(c.positionAnchor.seconds,42);assert.equal(c.positionAnchor.playing,false);assert.equal(c.statusFailed,true);assert.equal(updates,1);
});

test('a stale room import poll cannot block a new room or render its late error',async()=>{
  const {context:c,install}=harness(),old=deferred(),fresh=deferred(),jobs=[];let calls=0;
  Object.assign(c,{queueImportPolling:false,document:{hidden:false},renderQueueImport:job=>jobs.push(job),api:()=>++calls===1?old.promise:fresh.promise});
  install('async function pollQueueImport(', 'function createSongRow(');
  const a=c.pollQueueImport();c.roomGeneration++;const b=c.pollQueueImport();
  assert.equal(calls,2);fresh.resolve({import:{phase:'building',added:1}});await b;
  old.resolve({import:{phase:'error',error:'Previous room error'}});await a;
  assert.deepEqual(jobs,[{phase:'building',added:1}]);
});
test('restoring a hidden playlist defers scrolling until its content is visible',()=>{
  const {context:c,install}=harness(),frames=[],scrolls=[];
  Object.assign(c,{libraryViewActive:()=>false,libraryRestore:null,locateGeneration:1,filtered:Array(600),visible:60,requestAnimationFrame:fn=>frames.push(fn),renderSongs(){},window:{scrollTo:options=>scrolls.push(options)}});
  install('function restoreLibraryView(', 'function displayPlaylist(');
  const view={query:'live',visible:300,top:2000};c.restoreLibraryView(view);
  while(frames.length)frames.shift()();assert.equal(scrolls.length,0);assert.equal(c.libraryRestore.top,2000);
  c.libraryViewActive=()=>true;c.restoreLibraryView(c.libraryRestore);
  while(frames.length)frames.shift()();assert.equal(scrolls[0].top,2000);
});

for(const action of ['song','queue']){
  test(`${action} action failure from a previous room cannot toast or unlock a newer menu`,async()=>{
    const {context:c,element,install}=harness(),gate=deferred(),button=element('action-button');
    const dialog=element(action==='song'?'song-action-dialog':'queue-action-dialog');dialog.querySelectorAll=()=>[button];
    Object.assign(c,{chosenSong:{mid:'demo',title:'Demo'},chosenQueueTrack:{number:1,key:'demo'},api:()=>gate.promise});
    if(action==='song')install('async function addChosenSong(', "$('song-play-next').onclick");
    else install('async function editChosenQueue(', "$('queue-move-up').onclick");
    const pending=action==='song'?c.addChosenSong('end'):c.editChosenQueue('remove');
    assert.equal(button.disabled,true);c.roomGeneration++;c[action+'ActionGeneration']++;
    gate.reject(Error('old request failed'));await pending;
    assert.equal(c.toasts.length,0);assert.equal(button.disabled,true);assert.equal(dialog.open,true);
  });
  test(`${action} action success cannot close a menu reopened for another item`,async()=>{
    const {context:c,element,install}=harness(),gate=deferred();
    const dialog=element(action==='song'?'song-action-dialog':'queue-action-dialog');
    Object.assign(c,{chosenSong:{mid:'demo',title:'Demo'},chosenQueueTrack:{number:1,key:'demo'},api:()=>gate.promise});
    if(action==='song')install('async function addChosenSong(', "$('song-play-next').onclick");
    else install('async function editChosenQueue(', "$('queue-move-up').onclick");
    const pending=action==='song'?c.addChosenSong('end'):c.editChosenQueue('remove');
    c[action+'ActionGeneration']++;gate.resolve({});await pending;
    assert.equal(dialog.open,true);assert.equal(c.toasts.length,0);
  });
}
test('search failure exposes retry and a successful retry releases busy state',async()=>{
  const {context:c,element,install}=harness();let calls=0,appended=0;const attributes={};
  Object.assign(c,{quickSearchRequest:0,quickSearchMoreFailed:false,queryCache:{load:async()=>{if(++calls===1)throw Error('offline');return {songs:[{title:'Demo'}],hasMore:false};}},appendQuickResults(songs){appended+=songs.length;}});
  element('quick-search').value='Demo';element('quick-search-results').setAttribute=(key,value)=>attributes[key]=value;
  install('async function renderQuickResults(', 'async function loadMoreQuickResults(');
  await c.renderQuickResults();assert.equal(element('quick-search-retry').hidden,false);assert.equal(attributes['aria-busy'],'false');
  await c.renderQuickResults();assert.equal(element('quick-search-retry').hidden,true);assert.equal(appended,1);assert.equal(attributes['aria-busy'],'false');
});
test('pagination failure preserves the page and retries the same next page exactly once',async()=>{
  const {context:c,element,install}=harness(),pages=[];let fail=true,appended=0;
  Object.assign(c,{quickSearchRequest:2,quickSearchPage:1,quickSearchLoading:false,queryCache:{load:async(account,query,page)=>{pages.push(page);if(fail)throw Error('offline');return {songs:[1,2],page,hasMore:false};}},appendQuickResults(songs){appended+=songs.length;}});
  element('quick-search').value='Demo';element('quick-search-results').querySelectorAll=()=>Array(6);
  install('async function loadMoreQuickResults(', 'function scheduleQuickSearch(');
  await c.loadMoreQuickResults();assert.equal(c.quickSearchPage,1);assert.equal(appended,0);assert.equal(element('quick-search-more').textContent,'重试加载更多');
  fail=false;await c.loadMoreQuickResults();assert.deepEqual(pages,[2,2]);assert.equal(c.quickSearchPage,2);assert.equal(appended,2);
});

test('repeated initial connection failures do not produce a toast on every poll',async()=>{
  const {context:c,install}=harness();
  Object.assign(c,{currentStatus:null,api:async()=>{throw Error('offline');}});
  install('async function updateStatus(', 'async function settleTransport(');
  await c.updateStatus();await c.updateStatus();await c.updateStatus();
  assert.equal(c.statusFailed,true);assert.deepEqual(c.toasts,['offline']);
});
test('an old import completion cannot release the new room single-flight guard',async()=>{
  const {context:c,install}=harness(),old=deferred(),fresh=deferred();let calls=0;
  Object.assign(c,{queueImportPolling:false,document:{hidden:false},renderQueueImport(){},api:()=>++calls===1?old.promise:fresh.promise});
  install('async function pollQueueImport(', 'function createSongRow(');
  const a=c.pollQueueImport();c.roomGeneration++;const b=c.pollQueueImport();
  old.resolve({import:null});await a;await c.pollQueueImport();assert.equal(calls,2);
  fresh.resolve({import:null});await b;assert.equal(c.queueImportPolling,false);
});
