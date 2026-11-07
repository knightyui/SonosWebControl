const {chromium,webkit}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
let browser,styleAssets=[],buildStyleBundle;
const root=path.resolve(__dirname,'../public'),out=process.env.UI_TEST_OUTPUT||path.join(require('node:os').tmpdir(),'sonos-ui-verification');
const songs=Array.from({length:1646},(_,i)=>({id:i+1,mid:`test-${i+1}`,index:i+1,title:['晚风经过这里','慢慢喜欢你 (Live)','夜航','风的形状'][i%4]+(i>3?` ${i+1}`:''),artist:['林澈','莫文蔚','许知远','陈一'][i%4],album:'夜间电台',albumMid:'DEMOALBUM00001',duration:238}));
const warmArt='<svg xmlns="http://www.w3.org/2000/svg" width="700" height="700"><defs><linearGradient id="a" x2="1" y2="1"><stop stop-color="#d1b48f"/><stop offset=".5" stop-color="#8d6149"/><stop offset="1" stop-color="#18272a"/></linearGradient><radialGradient id="b"><stop stop-color="#e4d8b9"/><stop offset="1" stop-color="#bd825b"/></radialGradient></defs><rect width="700" height="700" fill="url(#a)"/><circle cx="415" cy="270" r="140" fill="url(#b)"/><path d="M0 480Q180 280 390 450T700 400V700H0Z" fill="#243333"/><path d="M0 570Q250 410 450 560T700 560V700H0Z" fill="#142324"/><text x="54" y="78" fill="#fff9eb" font-family="sans-serif" letter-spacing="7" font-size="19">NIGHT SESSIONS</text><text x="54" y="125" fill="#fff9eb" font-family="sans-serif" font-size="28">晚风经过这里</text><text x="55" y="655" fill="#c9d7d3" font-family="sans-serif" letter-spacing="4" font-size="13">VOL. 01 / LIN CHE</text></svg>';
const art=process.env.UI_TEST_TONE==='cool'?warmArt.replaceAll('#d1b48f','#8aa7ad').replaceAll('#8d6149','#315967').replaceAll('#e4d8b9','#dae6de').replaceAll('#bd825b','#6e9ba6'):warmArt;
let positionSeconds=84,positionAt=Date.now();
const mockPosition=()=>Math.min(238,positionSeconds+(playing?(Date.now()-positionAt)/1000:0));
const movePosition=seconds=>{positionSeconds=seconds;positionAt=Date.now();};
const timecode=seconds=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
let playing=true,track=1,volume=12,mode={},selected='liked',timer=null,queueCount=125,failSleep=false,failStatus=false,failSearch=false,failSearchMore=false,playlistRevision=0,account='demo-a',lastRequest,requests=[];
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');let name=u.pathname==='/'?'index.html':u.pathname.slice(1);if(name==='cover.svg'){res.setHeader('Content-Type','image/svg+xml');res.end(art);return;}if(!['index.html','app.js','style.css','favicon.svg',...styleAssets,'transport-sync.mjs','playlist-cache.mjs','dialog-interactions.mjs','library-navigation.mjs'].includes(name)){res.writeHead(404);res.end();return;}let data=name==='style.css'?(process.env.UI_TEST_BASELINE_CSS?await fs.readFile(process.env.UI_TEST_BASELINE_CSS):await buildStyleBundle(root)):await fs.readFile(path.join(root,name));res.setHeader('Content-Type',name.endsWith('.html')?'text/html;charset=utf-8':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/javascript');res.setHeader('Cache-Control','no-store');res.end(data);}catch(e){res.writeHead(500);res.end(e.message);}});
(async()=>{
 ({STYLE_ASSETS:styleAssets,buildStyleBundle}=await import('../style-assets.mjs'));
 await fs.mkdir(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await (process.env.UI_TEST_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 const context=await browser.newContext({viewport:{width:1366,height:900},deviceScaleFactor:1,hasTouch:process.env.UI_TEST_POINTER!=='mouse'});const page=await context.newPage();page.setDefaultTimeout(8000);page.on('requestfailed',r=>console.log('FAILED '+r.url()+' '+r.failure()?.errorText));const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR '+e.stack);});
 await page.route('**/api/**',async route=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname,b=req.postDataJSON()||{};lastRequest={path:p,...b};requests.push(p);let d={ok:true};
  if(p==='/api/qq/art')return route.fulfill({contentType:'image/svg+xml',body:art});
  if(p==='/api/status'&&failStatus)return route.fulfill({status:503,json:{error:'模拟断线'}});
  if(p==='/api/status')d={room:'客厅',roomId:'A',model:'Sonos Era 100',groupSize:1,groupVolume:volume,playing,title:songs[track-1].title,artist:songs[track-1].artist,songId:track,track,position:timecode(mockPosition()),duration:'3:58',volume,mute:false,shuffle:false,repeatAll:false,repeatOne:false,crossfade:false,albumArt:process.env.SONOS_NO_ART?null:'/cover.svg',...mode};
  else if(p==='/api/rooms')d={rooms:[{id:'A',name:'客厅',coordinatorId:'A',groupId:'G',volume},{id:'B',name:'书房',coordinatorId:'B',groupId:'G2',volume:8}],defaultId:'A'};
  else if(p==='/api/qq/session')d={connected:true,active:account,selectedId:selected,accounts:[{id:'demo-a'},{id:'demo-b'}],local:true,canQrLogin:true};
  else if(p==='/api/qq/session/select')account=b.id;
  else if(p==='/api/qq/login/qr')d={image:'data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="white"/><text x="30" y="90">PREVIEW</text></svg>').toString('base64')};
  else if(p==='/api/qq/login/poll')d={state:'waiting'};
  else if(p==='/api/playlists')d={selectedId:selected,playlists:[{id:'liked',title:'我喜欢',source:'liked',count:songs.length},{id:'2',title:'深夜的私人电台',source:'created',count:125}]};
  else if(p==='/api/playlists/select')selected=b.id;
  else if(p==='/api/playlist')d={id:selected,account,title:selected==='liked'?'我喜欢':'深夜的私人电台',songs:playlistRevision?songs.map((s,i)=>i===0?{...s,title:s.title+' '+playlistRevision}:s):songs};
  else if(p==='/api/lyrics')d={lines:[{time:0,text:'城市慢下来，灯火还未眠'},{time:65,text:'晚风经过这里，带走你的消息'},{time:90,text:'我们在夜色里，听见彼此呼吸'},{time:110,text:'愿所有的远方，都有温柔回应'}]};
  else if(p==='/api/search'){
   const page=Number(u.searchParams.get('page')||1),paged=u.searchParams.get('q')==='分页演示';
   if(failSearch||paged&&page===2&&failSearchMore)return route.fulfill({status:503,json:{error:'模拟网络失败'}});
   d={songs:songs.slice(paged&&page===2?4:0,paged&&page===2?8:4),page,total:paged?8:4,hasMore:paged&&page===1};
  }
  else if(p==='/api/history')d={songs:songs.slice(0,4).map(s=>({...s,playedAt:new Date().toISOString()}))};
  else if(p==='/api/queue/import')d={import:null};
  else if(p==='/api/queue'){const start=Number(u.searchParams.get('start')||0);d={start,total:queueCount,tracks:songs.slice(start,Math.min(queueCount,start+100)).map(s=>({number:s.index,title:s.title,artist:s.artist,key:'a'.repeat(24),albumMid:''}))};}
  else if(['/api/play','/api/play/playlist','/api/queue/play'].includes(p)){track=b.number||Number(String(b.mid).replace('test-',''))||1;movePosition(0);playing=true;}
  else if(p==='/api/control'){if(b.action==='play'){movePosition(mockPosition());playing=true;}else if(b.action==='pause'){movePosition(mockPosition());playing=false;}else if(b.action==='next'){track=track%125+1;movePosition(0);playing=true;}else if(b.action==='seek')movePosition(b.value);else if(b.action==='volume')volume=b.value;else mode[b.action]=b.value;}
  else if(p==='/api/sleep'){if(req.method()==='POST'){if(failSleep)return route.fulfill({status:503,json:{error:'模拟请求失败'}});timer=b.mode==='cancel'?null:b.mode==='minutes'?new Date(Date.now()+b.minutes*60000).toISOString():b.at;}d={endsAt:timer};}
  await route.fulfill({json:d});
 });
  const settle=async()=>{await page.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});await page.waitForFunction(()=>!document.body.classList.contains('mobile-player-closing'));};
 const shot=async(name)=>{
  await settle();
  if(process.env.UI_TEST_STYLE_SNAPSHOT){
   const styles=await page.evaluate(()=>{
    const properties=['display','position','width','height','min-width','min-height','max-width','max-height','top','right','bottom','left','box-sizing','margin','padding','gap','row-gap','column-gap','grid-template-columns','grid-template-rows','grid-column','grid-row','flex-direction','flex-grow','flex-shrink','flex-basis','align-items','align-self','justify-content','border-width','border-style','border-color','border-radius','background-color','background-image','box-shadow','color','font-family','font-size','font-weight','line-height','letter-spacing','text-align','white-space','overflow','overflow-x','overflow-y','opacity','visibility','outline','outline-offset','transform','backdrop-filter','-webkit-backdrop-filter','z-index','pointer-events','touch-action','animation-name','animation-duration','transition-property','transition-duration'];
    return [...document.querySelectorAll('*')].filter(e=>!e.closest('#song-list,#queue-list,#quick-search-results,#history-list')||e.parentElement?.childElementCount<6||e.closest('.song-entry,.queue-entry')===e.parentElement?.firstElementChild).map(e=>{
     const data={key:e.id||e.tagName+'.'+String(e.className?.baseVal??e.className),styles:{}};
     for(const pseudo of ['', '::before','::after']){const style=getComputedStyle(e,pseudo);data.styles[pseudo]=Object.fromEntries(properties.map(p=>[p,style.getPropertyValue(p)]));}
     return data;
    });
   });
   await fs.writeFile(`${out}/${name}.styles.json`,JSON.stringify(styles,null,2));
  }
  if(!process.env.SONOS_SKIP_SHOTS)await page.screenshot({path:`${out}/${name}.png`,timeout:12000});
 };
 const assertPaintedTrack=async selector=>{
  const png=await page.locator(selector).screenshot();
  const result=await page.evaluate(async base64=>{
   const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();
   const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
   const context=canvas.getContext('2d');context.drawImage(image,0,0);
   const {data}=context.getImageData(0,0,canvas.width,canvas.height),center=Math.floor(canvas.height/2);
   const luminance=(x,y)=>{const i=(y*canvas.width+x)*4;return (data[i]+data[i+1]+data[i+2])/3;};
   let painted=0;for(let x=3;x<canvas.width-3;x++)if(luminance(x,center)-(luminance(x,center-8)+luminance(x,center+8))/2>15)painted++;
   return {coverage:painted/(canvas.width-6),width:canvas.width,height:canvas.height};
  },png.toString('base64'));
  assert.ok(result.coverage>.55,selector+' track is not visibly painted: '+JSON.stringify(result));
 };
 const checks=[];const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
 const checkPlayerDrag=async()=>{
  await page.emulateMedia({reducedMotion:'no-preference'});
  await check('full player touch drag tracks the finger immediately, including reversal and cancellation',async()=>{
   const samples=await page.locator('.player').evaluate(player=>{
    const target=player.querySelector('.player-art');
    const send=(type,y)=>{const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperties(event,{touches:{value:type==='touchend'||type==='touchcancel'?[]:[{clientX:180,clientY:y}]},changedTouches:{value:[{clientX:180,clientY:y}]}});target.dispatchEvent(event);return event.defaultPrevented;};
    send('touchstart',100);const values=[];
    for(const offset of [30,80,2,-12,110]){const prevented=send('touchmove',100+offset);values.push({offset,prevented,y:player.getBoundingClientRect().y,duration:getComputedStyle(player).transitionDuration});}
    send('touchcancel',210);return values;
   });
   for(const sample of samples){assert.equal(sample.duration,'0s',JSON.stringify(sample));assert.ok(Math.abs(sample.y-Math.max(0,sample.offset))<1,JSON.stringify(sample));assert.equal(sample.prevented,true);}
   await settle();assert.ok(Math.abs((await page.locator('.player').boundingBox()).y)<1);
  });
  await check('full player mouse drag follows immediately and finishes with a visible dismissal',async()=>{
   await page.mouse.move(180,70);await page.mouse.down();await page.mouse.move(180,120);
   const short=await page.locator('.player').evaluate(e=>({y:e.getBoundingClientRect().y,duration:getComputedStyle(e).transitionDuration}));
   assert.equal(short.duration,'0s');assert.ok(Math.abs(short.y-50)<1,JSON.stringify(short));
   await page.mouse.up();await settle();assert.ok(Math.abs((await page.locator('.player').boundingBox()).y)<1);
   await page.mouse.move(180,70);await page.mouse.down();await page.mouse.move(180,190);await page.mouse.up();
   await page.waitForTimeout(90);const closing=await page.locator('.player').boundingBox();assert.ok(closing.y>150,JSON.stringify(closing));
   await page.waitForFunction(()=>!document.body.classList.contains('mobile-player-open'));
   assert.equal(await page.locator('#mini-player').isVisible(),true);
   await page.locator('#mini-expand').click();await settle();
  });
 };
 await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>document.querySelector('#song-list .song')&&!document.querySelector('#song-list .song').disabled,null,{timeout:10000});
 if(process.env.UI_TEST_PLAYER_GESTURE_ONLY){
  await page.setViewportSize({width:402,height:874});await page.locator('#mini-expand').click();await settle();await checkPlayerDrag();
  assert.deepEqual(errors,[]);await fs.writeFile(`${out}/checks.json`,JSON.stringify({checks,errors},null,2));await browser.close();await new Promise(r=>server.close(r));console.log('OUTPUT '+out);return;
 }
 if(!process.env.UI_TEST_BASELINE_CSS)await check('component styles load in one request without duplicate variant selectors',async()=>{
  const contract=await page.evaluate(()=>{
   const seen=new Set(),duplicates=[];let imports=0;
   const split=selector=>{const parts=[];let start=0,depth=0;for(let i=0;i<selector.length;i++){if('(['.includes(selector[i]))depth++;if(')]'.includes(selector[i]))depth--;if(selector[i]===','&&depth===0){parts.push(selector.slice(start,i).trim());start=i+1;}}parts.push(selector.slice(start).trim());return parts;};
   const walk=(rules,context='')=>{for(const rule of rules){if(rule.type===3){imports++;walk(rule.styleSheet.cssRules,context);continue;}if(rule.selectorText){for(const selector of split(rule.selectorText)){const key=context+'|'+selector;if(seen.has(key))duplicates.push(key);seen.add(key);}}else if(rule.cssRules&&!rule.name)walk(rule.cssRules,context+'|'+rule.conditionText);}};
   for(const sheet of document.styleSheets)walk(sheet.cssRules);
   return {imports,duplicates};
  });
  assert.equal(contract.imports,0);assert.deepEqual(contract.duplicates,[]);
 });
 await check('desktop library starts with no horizontal overflow',async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false));await shot('desktop');await check('desktop seek and volume tracks are visibly painted',async()=>{await assertPaintedTrack('#seek');await assertPaintedTrack('#volume');});
 await check('song rows provide playback without a competing playlist play button',async()=>{assert.equal(await page.locator('#playlist-play').count(),0);await page.locator('#song-list .song').first().click();await page.waitForFunction(()=>!document.querySelector('#song-list .song').disabled);assert.equal(track,1);});
 await check('secondary panel can return to its parent',async()=>{await page.locator('#utilities-open').click();await page.locator('#sleep-open').click();await page.locator('#sleep-back').click();assert.equal(await page.locator('#utilities-dialog').evaluate(e=>e.open),true);await page.locator('#utilities-close').click();});

 await check('desktop floating search only appears when the main search is offscreen',async()=>{
  await page.locator('#catalog-search-open').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.getElementById('quick-search-open').hidden);
  const target=await page.locator('#catalog-search-open').evaluate(e=>e.getBoundingClientRect().bottom+scrollY+40);
  await page.evaluate(y=>scrollTo(0,y),target);await page.locator('#quick-search-open').waitFor({state:'visible'});
  await page.evaluate(()=>scrollTo(0,0));
 });
 await check('history refresh updates the visible history without fetching playlists',async()=>{
  await page.locator('#history-tab').click();await page.locator('#history-list .song').first().waitFor();requests=[];
  assert.equal(await page.locator('#refresh').getAttribute('aria-label'),'刷新最近播放');await page.locator('#refresh').click();
  await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
  assert.ok(requests.includes('/api/history'));assert.ok(!requests.some(p=>p==='/api/playlist'||p==='/api/playlists'));
  await page.locator('#playlist-tab').click();assert.equal(await page.locator('#refresh').getAttribute('aria-label'),'刷新歌单');
 });
 await page.setViewportSize({width:402,height:874});await page.evaluate(()=>scrollTo(0,0));await shot('mobile-library');await check('mini player progress track is visibly painted',()=>assertPaintedTrack('#mini-seek'));

 await check('mobile library gives content priority and uses a compact dock',async()=>{
  const layout=await page.evaluate(()=>{
   const rect=id=>document.getElementById(id).getBoundingClientRect().toJSON();
   return {dock:rect('mobile-dock'),playlist:rect('playlist-open'),picker:document.querySelector('.library-pickers').getBoundingClientRect().toJSON(),first:document.querySelector('#song-list .song').getBoundingClientRect().toJSON(),account:rect('account-open'),refresh:rect('refresh')};
  });
  assert.ok(layout.first.y<874*.45,JSON.stringify(layout));assert.ok(layout.dock.height<=140,JSON.stringify(layout.dock));
  assert.ok(Math.abs(layout.playlist.width-layout.picker.width)<1);
  assert.ok(layout.account.width>=44&&layout.account.height>=44&&layout.refresh.width>=44&&layout.refresh.height>=44);
 });
 await check('glass dock keeps a translucent fill and background blur',async()=>{
  const material=await page.locator('#mobile-dock').evaluate(element=>{
   const style=getComputedStyle(element),canvas=document.createElement('canvas');canvas.width=canvas.height=1;
   const context=canvas.getContext('2d');context.fillStyle=style.backgroundColor;context.fillRect(0,0,1,1);
   return {alpha:context.getImageData(0,0,1,1).data[3]/255,blur:style.backdropFilter||style.webkitBackdropFilter};
  });
  assert.ok(material.alpha>.45&&material.alpha<.9,JSON.stringify(material));assert.notEqual(material.blur,'none');
 });
 await check('sheet controls share touch targets and retain keyboard focus feedback',async()=>{
  await page.locator('#account-open').click();await settle();
  const close=page.locator('#account-close'),bounds=await close.boundingBox();assert.equal(bounds.width,44);assert.equal(bounds.height,44);
  assert.equal(await close.evaluate(e=>getComputedStyle(e).outlineStyle),'none');
  for(let i=0;i<6;i++){await page.keyboard.press(process.env.UI_TEST_BROWSER==='webkit'?'Alt+Tab':'Tab');if(await close.evaluate(e=>e===document.activeElement))break;}
  assert.equal(await close.evaluate(e=>e===document.activeElement),true);
  assert.ok(await close.evaluate(e=>parseFloat(getComputedStyle(e).outlineWidth)>=2));
  await page.keyboard.press('Escape');
 });
 await check('mini progress interaction stays in the library',async()=>{
  await page.locator('#mini-seek').click({position:{x:80,y:12}});
  assert.equal(await page.locator('#mobile-dock').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.body.classList.contains('mobile-player-open')),false);
 });
 await check('safe-area inset keeps the dock clear and the last song reachable',async()=>{
  await page.evaluate(()=>document.documentElement.style.setProperty('--dock-safe-bottom','34px'));await settle();
  const dock=await page.locator('#mobile-dock').boundingBox();assert.ok(dock.y+dock.height<=874-34);
  await shot('mobile-safe-area');
  await page.locator('#search').fill('1646');await page.waitForFunction(()=>document.querySelectorAll('#song-list .song').length===1);await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await settle();
  const last=page.locator('#song-list .song').last();await last.scrollIntoViewIfNeeded();await settle();
  const [row,d]=await Promise.all([last.boundingBox(),page.locator('#mobile-dock').boundingBox()]);assert.ok(row.y+row.height<=d.y,JSON.stringify({row,d}));
  await page.locator('#search').fill('');await page.evaluate(()=>{document.documentElement.style.removeProperty('--dock-safe-bottom');scrollTo(0,0);});
 });
 await page.locator('#mini-expand').click();await shot('mobile-player');await checkPlayerDrag();
 await check('mobile full player fits a normal phone viewport',async()=>{const r=await page.locator('.player').evaluate(e=>({height:e.clientHeight,scroll:e.scrollHeight}));assert.ok(r.height>0&&r.scroll<=r.height+2,JSON.stringify(r));});
 await page.locator('#queue-open').click();await shot('mobile-queue');await check('queue volume track is visibly painted',()=>assertPaintedTrack('#queue-volume'));
 await check('queue more controls has a return path to queue',async()=>{await page.locator('#queue-utilities-open').click();await page.locator('#utilities-back').click();assert.equal(await page.locator('#queue-dialog').evaluate(e=>e.open),true);await page.locator('#queue-close').click();});
 await page.locator('#utilities-open').click();
 if(process.env.UI_TEST_POINTER!=='mouse')await check('touch utility rows do not retain a hover highlight',async()=>{
  await page.locator('#rooms-open').hover();assert.equal(await page.locator('#rooms-open').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
 });
 await shot('mobile-controls');await page.locator('#sleep-open').click();
 await check('timer presets submit and show persistent feedback',async()=>{await page.locator('[data-sleep-minutes="30"]').click();await page.waitForFunction(()=>!document.querySelector('#sleep-feedback').hidden);assert.match(await page.locator('#sleep-feedback').innerText(),/已设置/);assert.equal(await page.locator('#sleep-minutes').inputValue(),'30');});await shot('mobile-timer');
 await check('timer failures remain inline and can be retried',async()=>{failSleep=true;await page.locator('#sleep-minutes').fill('45');await page.locator('#sleep-form button[value="minutes"]').click();await page.waitForFunction(()=>document.querySelector('#sleep-feedback').classList.contains('error'));failSleep=false;await page.locator('#sleep-form button[value="minutes"]').click();await page.waitForFunction(()=>!document.querySelector('#sleep-feedback').classList.contains('error'));await page.locator('#sleep-cancel').click();});
 await page.locator('#sleep-close').click();await page.locator('#lyrics-open').click();await shot('mobile-lyrics');await page.locator('#lyrics-close').click();await page.locator('#mobile-player-back').click();await page.locator('#mobile-search-open').click();await page.locator('#quick-search').fill('晚风');await page.locator('#quick-search').press('Enter');await page.waitForFunction(()=>document.querySelectorAll('#quick-search-results .song').length>0);await shot('mobile-search');
 await check('closing search retains query and results',async()=>{await page.locator('#quick-search-close').click();await page.locator('#mobile-search-open').click();assert.equal(await page.locator('#quick-search').inputValue(),'晚风');assert.equal(await page.locator('#quick-search-results .song').count(),4);});
 await check('search song actions contain queue actions and row playback retains search',async()=>{await page.locator('#quick-search-results .song-more-trigger').nth(1).click();assert.equal(await page.locator('#song-play-now').count(),0);assert.deepEqual(await page.locator('#song-action-dialog .action-options button').allTextContents(),['下一首播放','加入队列末尾']);await page.locator('#song-action-close').click();await page.locator('#quick-search-results .song').nth(1).click();await page.waitForFunction(()=>document.querySelector('#quick-search-state').textContent.startsWith('正在播放'));assert.equal(track,2);assert.equal(await page.locator('#quick-search-dialog').evaluate(e=>e.open),true);});
 await check('clear search starts fresh without closing the search page',async()=>{await page.locator('#quick-search-clear').click();assert.equal(await page.locator('#quick-search').inputValue(),'');assert.equal(await page.locator('#quick-search-results .song').count(),0);});
 await page.locator('#quick-search-close').click();
 for(const id of ['account','playlist']){await page.locator('#'+id+'-open').click();await shot('mobile-'+id);if(id==='account'){await check('account selection has a full-size hit target in every browser',async()=>{const rect=await page.locator('#qq-account').boundingBox();assert.ok(rect.height>=44,JSON.stringify(rect));});}await page.locator('#'+id+'-close').click();}

 await check('account switching closes the chooser and refreshes the selected library',async()=>{
  await page.locator('#account-open').click();await page.locator('#qq-account').selectOption('demo-b');
  await page.waitForFunction(()=>!document.getElementById('account-dialog').open);
  assert.match(await page.locator('#account-label').textContent(),/mo-b/);
  await page.waitForFunction(()=>document.querySelector('#song-list .song')&&!document.querySelector('#song-list .song').disabled);
 });
 await check('QR login returns to account management through its back action',async()=>{
  await page.locator('#account-open').click();await page.locator('#login').click();
  await page.locator('#qr-image').waitFor({state:'visible'});await shot('mobile-login');
  await page.locator('#login-back').click();assert.equal(await page.locator('#account-dialog').evaluate(e=>e.open),true);
  assert.equal(await page.locator('#login-dialog').evaluate(e=>e.open),false);await page.locator('#account-close').click();
 });
 await page.locator('#history-tab').click();await page.locator('#history-list .song').first().waitFor();await shot('mobile-history');await page.locator('#playlist-tab').click();
 await check('room selection is directly accessible from connection status',async()=>{await page.locator('#connection').click();await page.locator('#rooms-list .room-entry').first().waitFor();assert.equal(await page.locator('#rooms-back').isVisible(),false);await shot('mobile-rooms');await page.locator('#rooms-close').click();});

 await check('nested queue actions dismiss without a queue focus ring',async()=>{
  await page.locator('#mini-expand').click();await settle();await page.locator('#queue-open').click();await settle();
  await page.locator('.queue-more-trigger').first().click();await settle();
  const bounds=await page.locator('#queue-action-dialog').boundingBox();await page.mouse.click(10,Math.max(2,bounds.y-20));
  await page.waitForFunction(()=>!document.querySelector('#queue-action-dialog').open);
  assert.equal(await page.locator('#queue-dialog').evaluate(e=>getComputedStyle(e).outlineStyle),'none');
  await page.locator('#queue-close').click();
 });
 await check('queue and more sheets drag down to close and release their state',async()=>{
  for(const [open,id] of [['queue-open','queue-dialog'],['utilities-open','utilities-dialog']]){
   await page.locator('#'+open).click();await settle();const b=await page.locator('#'+id).boundingBox();
   await page.mouse.move(b.x+b.width/2,b.y+12);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+140,{steps:12});await page.mouse.up();
   await page.waitForFunction(id=>!document.getElementById(id).open,id);
   assert.equal(await page.locator('#'+id).evaluate(e=>e.classList.contains('sheet-dismissing')),false);
  }
 });
 await check('timer input focus and blur preserve the open panel',async()=>{
  await page.locator('#utilities-open').click();await page.locator('#sleep-open').click();await settle();
  await page.locator('#sleep-minutes').fill('20');await page.locator('#sleep-time').fill('23:30');
  await page.locator('#sleep-time').blur();assert.equal(await page.locator('#sleep-dialog').evaluate(e=>e.open),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#sleep-dialog').evaluate(e=>e.open),false);
 });
 await check('mobile navigation hides while editing search',async()=>{
  await page.locator('#mobile-player-back').click();await settle();await page.locator('#mobile-search-open').click();
  await page.locator('#quick-search').focus();assert.equal(await page.locator('.search-bottom-nav').isVisible(),false);
  await page.locator('#quick-search').press('Enter');assert.equal(await page.locator('.search-bottom-nav').isVisible(),true);
  await page.locator('#quick-search-close').click();
 });
 await page.setViewportSize({width:375,height:667});await page.evaluate(()=>scrollTo(0,0));await shot('small-library');
 if(!process.env.UI_TEST_BASELINE_CSS)await check('narrow phone keeps header actions on one row and transport targets at least 44px',async()=>{
  const heading=await page.locator('.mobile-header-title').boundingBox(),account=await page.locator('#account-open').boundingBox();
  assert.ok(Math.abs((heading.y+heading.height/2)-(account.y+account.height/2))<2);
 });
 await page.locator('#mini-expand').click();await shot('small-player');
 if(!process.env.UI_TEST_BASELINE_CSS)await check('small phone transport buttons keep standard touch targets',async()=>{
  for(const id of ['shuffle','previous','next','repeat-one','volume-down','volume-up']){const b=await page.locator('#'+id).boundingBox();assert.ok(b.width>=44&&b.height>=44,JSON.stringify({id,...b}));}
 });
 await check('small phone keeps the full player usable',async()=>{const r=await page.locator('.player').evaluate(e=>({height:e.clientHeight,scroll:e.scrollHeight}));assert.ok(r.height>0&&r.scroll<=r.height+2,JSON.stringify(r));});
 await check('empty queue leads back to the playlist',async()=>{queueCount=0;await page.locator('#queue-open').click();await page.locator('#queue-browse').waitFor({state:'visible'});await page.locator('#queue-browse').click();assert.equal(await page.locator('#queue-dialog').evaluate(e=>e.open),false);queueCount=125;});
 await page.setViewportSize({width:320,height:568});await settle();await page.evaluate(()=>scrollTo(0,0));await shot('compact-library');await check('compact phone library has no horizontal overflow',async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false));
 await page.setViewportSize({width:402,height:874});await page.emulateMedia({reducedMotion:'reduce',contrast:'more'});await page.locator('#account-open').click();await shot('accessible-account');
 await check('high contrast uses an opaque fallback material',async()=>assert.equal(await page.locator('#account-dialog').evaluate(e=>getComputedStyle(e).backdropFilter),'none'));
 await page.locator('#account-close').click();await page.emulateMedia({reducedMotion:'reduce',contrast:'no-preference'});await page.setViewportSize({width:874,height:402});await shot('landscape-library');await check('landscape library does not overflow horizontally',async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false));
 await page.setViewportSize({width:402,height:874});await page.emulateMedia({reducedMotion:'reduce',contrast:'no-preference'});await page.evaluate(()=>scrollTo(0,0));
 await check('Chinese composition submits only the finalized query and reuses cached results',async()=>{
  await page.locator('#mobile-search-open').click();if(await page.locator('#quick-search-clear').isVisible())await page.locator('#quick-search-clear').click();
  const before=requests.filter(p=>p==='/api/search').length;
  await page.locator('#quick-search').dispatchEvent('compositionstart');await page.locator('#quick-search').fill('zhong');
  await page.locator('#quick-search').dispatchEvent('keydown',{key:'Enter',isComposing:true,keyCode:229});await page.waitForTimeout(350);
  assert.equal(requests.filter(p=>p==='/api/search').length,before);assert.equal(await page.locator('#quick-search').evaluate(e=>e===document.activeElement),true);
  await page.locator('#quick-search').fill('中文完成');await page.locator('#quick-search').dispatchEvent('compositionend');
  await page.waitForFunction(()=>document.querySelectorAll('#quick-search-results .song').length===4);
  assert.equal(requests.filter(p=>p==='/api/search').length,before+1);
  await page.locator('#quick-search-clear').click();await page.locator('#quick-search').fill('中文完成');await page.locator('#quick-search').press('Enter');
  await page.waitForFunction(()=>document.querySelectorAll('#quick-search-results .song').length===4);assert.equal(requests.filter(p=>p==='/api/search').length,before+1);
  await page.locator('#quick-search-close').click();
 });
 await check('playlist filter and deep browsing position survive switching playlists and reloading',async()=>{
  const firstTitle=await page.locator('#song-list .song').first().textContent();
  await page.locator('#search').dispatchEvent('compositionstart');await page.locator('#search').fill('夜航');
  assert.equal(await page.locator('#song-list .song').first().textContent(),firstTitle);
  await page.locator('#search').dispatchEvent('compositionend');await page.locator('#search').blur();await page.evaluate(()=>scrollTo(0,1400));await page.waitForTimeout(400);
  const top=await page.evaluate(()=>scrollY);assert.ok(top>1000);
  await page.locator('#playlist-open').scrollIntoViewIfNeeded();
  // Save the actual browsing position before opening the chooser, then invoke its existing action.
  await page.evaluate(y=>{scrollTo(0,y);dispatchEvent(new Event('pagehide'));document.getElementById('playlist-open').click();},top);
  await page.locator('.playlist-choice').filter({hasText:'深夜的私人电台'}).click();await page.waitForFunction(()=>!document.getElementById('playlist-dialog').open);
  assert.equal(await page.locator('#search').inputValue(),'');
  await page.locator('#playlist-open').click();await page.locator('.playlist-choice').filter({hasText:'我喜欢'}).click();await page.waitForFunction(()=>!document.getElementById('playlist-dialog').open);
  assert.equal(await page.locator('#search').inputValue(),'夜航');await page.waitForFunction(y=>Math.abs(scrollY-y)<5,top);
  await page.reload();await page.waitForFunction(()=>document.querySelector('#song-list .song')&&!document.querySelector('#song-list .song').disabled);
  assert.equal(await page.locator('#search').inputValue(),'夜航');await page.waitForFunction(y=>Math.abs(scrollY-y)<5,top);
  await page.locator('#search').fill('');await page.evaluate(()=>scrollTo(0,0));
 });
 await check('account changes keep independent playlist browsing filters',async()=>{
  const switchAccount=async id=>{await page.locator('#account-open').click();await page.locator('#qq-account').selectOption(id);await page.waitForFunction(()=>!document.getElementById('account-dialog').open);};
  await switchAccount('demo-a');assert.equal(await page.locator('#search').inputValue(),'');
  await page.locator('#search').fill('慢慢');await page.locator('#search').blur();
  await switchAccount('demo-b');assert.equal(await page.locator('#search').inputValue(),'');
  await switchAccount('demo-a');assert.equal(await page.locator('#search').inputValue(),'慢慢');
  await switchAccount('demo-b');
 });
 await check('failed searches and pagination can retry without losing context or earlier songs',async()=>{
  await page.locator('#mobile-search-open').click();failSearch=true;
  await page.locator('#quick-search').fill('重试测试');await page.locator('#quick-search').press('Enter');
  await page.locator('#quick-search-retry').waitFor({state:'visible'});
  assert.equal(await page.locator('#quick-search-results').getAttribute('aria-busy'),'false');
  const retry=await page.locator('#quick-search-retry').boundingBox();assert.ok(retry.height>=44);
  await shot('mobile-search-retry');failSearch=false;await page.locator('#quick-search-retry').click();
  await page.waitForFunction(()=>document.querySelectorAll('#quick-search-results .song').length===4);
  assert.equal(await page.locator('#quick-search').inputValue(),'重试测试');assert.equal(await page.locator('#quick-search-retry').isVisible(),false);
  await page.locator('#quick-search').fill('分页演示');await page.locator('#quick-search').press('Enter');
  await page.locator('#quick-search-more').waitFor({state:'visible'});failSearchMore=true;await page.locator('#quick-search-more').click();
  await page.waitForFunction(()=>document.getElementById('quick-search-more').textContent==='重试加载更多');
  assert.equal(await page.locator('#quick-search-results .song').count(),4);
  failSearchMore=false;await page.locator('#quick-search-more').click();await page.waitForFunction(()=>document.querySelectorAll('#quick-search-results .song').length===8);
  assert.equal(await page.locator('#quick-search').inputValue(),'分页演示');await page.locator('#quick-search-close').click();
 });
 await check('background playlist updates leave history and the full player scroll untouched',async()=>{
  const refreshActiveAccount=async()=>{await page.evaluate(()=>{document.getElementById('account-open').click();document.getElementById('qq-account').dispatchEvent(new Event('change'));});await page.waitForFunction(()=>!document.getElementById('account-dialog').open);};
  await page.locator('#search').fill('');await page.locator('#search').blur();await page.evaluate(()=>{scrollTo(0,1400);dispatchEvent(new Event('pagehide'));document.getElementById('history-tab').click();});
  await page.locator('#history-list .song').first().waitFor();const top=await page.evaluate(()=>scrollY);playlistRevision++;
  await refreshActiveAccount();await settle();assert.equal(await page.evaluate(()=>scrollY),top);
  await page.evaluate(()=>document.getElementById('playlist-tab').click());await page.waitForFunction(()=>Math.abs(scrollY-1400)<5);
  await page.locator('#mini-expand').click();await settle();const playerTop=await page.locator('.player').evaluate(e=>e.scrollTop);playlistRevision++;
  await refreshActiveAccount();await settle();assert.equal(await page.locator('.player').evaluate(e=>e.scrollTop),playerTop);
  await page.locator('#mobile-player-back').click();await settle();await page.waitForFunction(()=>Math.abs(scrollY-1400)<5);await page.evaluate(()=>scrollTo(0,0));
 });
 await check('playback feedback clears confirmation and freezes progress on connection loss',async()=>{
  await page.locator('#mini-toggle-play').click();await page.waitForFunction(()=>document.getElementById('mini-toggle-play').getAttribute('aria-busy')==='false');
  assert.match(await page.locator('#connection').textContent(),/已连接/);
  if(!playing){await page.locator('#mini-toggle-play').click();await page.waitForFunction(()=>document.getElementById('mini-toggle-play').getAttribute('aria-busy')==='false');}
  assert.equal(playing,true);
  failStatus=true;await page.evaluate(()=>dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.getElementById('connection').textContent.includes('连接中断'));
  const position=await page.locator('#mini-position').textContent();await page.waitForTimeout(1200);assert.equal(await page.locator('#mini-position').textContent(),position);
  failStatus=false;await page.evaluate(()=>dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.getElementById('connection').textContent.includes('已连接'));
 });
 await page.locator('#mini-expand').click();await page.waitForFunction(()=>document.getElementById('toggle-play').getAttribute('aria-busy')==='false');await shot('mobile-player');
 await page.locator('#utilities-open').click();await shot('mobile-controls');await page.locator('#utilities-close').click();await page.locator('#mobile-player-back').click();
 await check('initial offline polling keeps connection feedback without repeated error toasts',async()=>{
  await page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
   window.uiToastWrites=0;new MutationObserver(()=>window.uiToastWrites++).observe(document.getElementById('toast'),{childList:true,subtree:true});
  }));
  failStatus=true;await page.reload();await page.waitForFunction(()=>document.getElementById('connection').textContent.includes('连接中断'));
  assert.equal(await page.evaluate(()=>window.uiToastWrites),1);
  for(let i=0;i<2;i++){
   const reply=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/status');
   await page.evaluate(()=>dispatchEvent(new Event('online')));await reply;await page.waitForTimeout(30);
  }
  assert.equal(await page.evaluate(()=>window.uiToastWrites),1);
  failStatus=false;await page.evaluate(()=>dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.getElementById('connection').textContent.includes('已连接'));
 });
 await check('no uncaught browser errors',async()=>assert.deepEqual(errors,[]));
 await fs.writeFile(`${out}/checks.json`,JSON.stringify({checks,errors},null,2));await browser.close();await new Promise(r=>server.close(r));console.log('OUTPUT '+out);
})().catch(async error=>{console.error(error);await browser?.close();server.close();process.exitCode=1;});
