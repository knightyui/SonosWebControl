import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseSonosResponse,discoverSonos,inspectSonos,createSonosLocator} from '../sonos-discovery.mjs';
const reply=(ip='192.168.10.2')=>Buffer.from(`HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\nLOCATION: http://${ip}:1400/xml/device_description.xml\r\n\r\n`);
const device=(origin,id='RINCON_A')=>({origin,id,description:`<UDN>uuid:${id}</UDN>`});

test('SSDP validates Sonos identity, sender and local description URL',()=>{
  assert.equal(parseSonosResponse(reply(),'192.168.10.2'),'http://192.168.10.2:1400');
  assert.equal(parseSonosResponse(reply(),'192.168.10.3'),null);
  for(const [from,to] of [[':1400',':80'],['http://','https://'],['HTTP/1.1 200','HTTP/1.1 404'],['ZonePlayer','printer'],['.xml','.xml?redirect=1'],['192.168.10.2','example.com']]){
    assert.equal(parseSonosResponse(Buffer.from(reply().toString().replace(from,to)),'192.168.10.2'),null);
  }
});
test('discovery scans interfaces and deduplicates devices, tolerates errors and closes sockets',async()=>{
  const sockets=[];
  const createSocket=()=>{
    const s=new EventEmitter();sockets.push(s);
    s.bind=(_,address,cb)=>{s.address=address;queueMicrotask(cb);};s.setMulticastInterface=()=>{};s.setMulticastTTL=()=>{};
    s.send=(data,port,address,cb)=>{
      assert.match(data.toString(),/M-SEARCH/);assert.equal(port,1900);assert.equal(address,'239.255.255.250');
      if(s.address==='bad'){s.emit('error',Error('Unavailable'));return;}
      for(const ip of ['192.168.10.2','192.168.10.2','192.168.10.3'])s.emit('message',reply(ip),{address:ip});cb(null);
    };s.close=()=>{s.closed=true;};return s;
  };
  assert.deepEqual(await discoverSonos({addresses:['good','bad'],createSocket,timeoutMs:20}),['http://192.168.10.2:1400','http://192.168.10.3:1400']);
  assert.ok(sockets.every(s=>s.closed));
  assert.deepEqual(await discoverSonos({addresses:['x'],createSocket:()=>{throw Error('No socket');}}),[]);
  assert.deepEqual(await discoverSonos({addresses:[]}),[]);
});
test('fixed IP remains compatible without a scan',async()=>{
  let scans=0;
  const locator=createSonosLocator({seedIp:'192.168.10.2',discover:async()=>{scans++;return [];},inspect:async origin=>device(origin)});
  assert.equal((await locator.resolve()).origin,'http://192.168.10.2:1400');await locator.resolve();assert.equal(scans,0);
  assert.throws(()=>createSonosLocator({seedIp:'invalid'}),/IPv4/);
});
test('stale IP falls back to verified discovery and rejects unavailable devices',async()=>{
  const locator=createSonosLocator({seedIp:'192.168.10.9',discover:async()=>['good','bad'],inspect:async origin=>{if(origin!=='good')throw Error('Offline');return device(origin);}});
  assert.equal((await locator.resolve()).origin,'good');
});
test('multiple devices have deterministic selection and preserve identity after IP change',async()=>{
  let moved=false,scans=0;
  const locator=createSonosLocator({discover:async()=>{scans++;return moved?['new-a','b']:['b','a'];},inspect:async origin=>device(origin,origin==='b'?'RINCON_B':'RINCON_A')});
  assert.equal((await locator.resolve()).origin,'a');locator.invalidate('other');await locator.resolve();assert.equal(scans,1);
  moved=true;locator.invalidate('a');assert.equal((await locator.resolve()).origin,'new-a');assert.equal((await locator.resolve(true)).id,'RINCON_A');
});
test('concurrent requests share discovery and failures throttle retries while manual refresh works',async()=>{
  let time=0,scans=0,available=false;
  const locator=createSonosLocator({now:()=>time,discover:async()=>{scans++;return available?['a']:[];},inspect:async origin=>device(origin)});
  const results=await Promise.allSettled([locator.resolve(),locator.resolve()]);assert.ok(results.every(r=>r.status==='rejected'));assert.equal(scans,1);
  await assert.rejects(locator.resolve(),/未发现/);assert.equal(scans,1);available=true;await locator.resolve(true);assert.equal(scans,2);
  locator.invalidate('a');available=false;time=6000;await assert.rejects(locator.resolve());time=12000;available=true;await locator.resolve();assert.equal(scans,4);
});
test('topology read recovers from disconnected primary by rediscovery',async()=>{
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');let invalidated,scans=0;
  const c=vm.createContext({locator:{resolve:async force=>{if(force)scans++;return {origin:force?'new':'old'};},invalidate:origin=>{invalidated=origin;}},topologyFor:async({origin})=>{if(origin==='old')throw Error('Disconnected');return {rooms:[{id:'A'}]};}});
  vm.runInContext(source.slice(source.indexOf('async function topology('),source.indexOf('async function topologyFor(')),c);
  assert.equal((await c.topology()).rooms.length,1);assert.equal(invalidated,'old');assert.equal(scans,1);
});
test('multiroom topology preserves grouping and omits hidden stereo members',async()=>{
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const xml='<ZoneGroup ID="group" Coordinator="RINCON_A"><ZoneGroupMember UUID="RINCON_A" ZoneName="Living" Location="http://192.168.10.2:1400/xml/device_description.xml"/><ZoneGroupMember UUID="RINCON_B" ZoneName="Kitchen" Location="http://192.168.10.3:1400/xml/device_description.xml"/><ZoneGroupMember UUID="RINCON_C" Invisible="1" Location="http://192.168.10.4:1400/xml/device_description.xml"/></ZoneGroup>';
  const c=vm.createContext({URL,soap:async()=>xml,tag:(s,name)=>name==='ZoneGroupState'?s:/<UDN>(.*?)<\/UDN>/.exec(s)?.[1]||'',attr:(s,name)=>new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1]||''});
  vm.runInContext(source.slice(source.indexOf('async function topologyFor('),source.indexOf('async function coordinator(')),c);
  const result=await c.topologyFor(device('unused'));assert.equal(result.rooms.length,2);assert.equal(result.defaultId,'RINCON_A');assert.equal(result.rooms[1].coordinatorId,'RINCON_A');assert.equal(result.rooms[1].device,'http://192.168.10.3:1400');
  const hidden=await c.topologyFor(device('unused','RINCON_C'));assert.equal(hidden.defaultId,'RINCON_A');assert.equal(hidden.defaultModel,'Sonos');
});
test('playback status uses the selected discovered room IP rather than fixed configuration',async()=>{
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const c=vm.createContext({URL,coordinator:async()=>({target:'http://192.168.10.2:1400',device:'http://192.168.10.3:1400',room:'Kitchen',roomId:'B',groupSize:1,model:'Sonos'}),soap:async(_,action)=>action,tag:(xml,name)=>name==='CurrentTransportState'?'PLAYING':name==='RelTime'?'0:01:00':'',shuffleModes:new Map()});
  vm.runInContext(source.slice(source.indexOf('async function status('),source.indexOf('async function control(')),c);
  const result=await c.status('B');assert.equal(result.ip,'192.168.10.3');assert.equal(result.playing,true);assert.equal(result.position,'0:01:00');
});
test('discovered descriptions must identify a Sonos device and never follow redirects',async t=>{
  let xml='<manufacturer>Sonos, Inc.</manufacturer><UDN>uuid:RINCON_A</UDN>',ok=true;
  t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,'http://192.168.10.2:1400/xml/device_description.xml');assert.equal(options.redirect,'error');assert.ok(options.signal);return {ok,text:async()=>xml};});
  assert.equal((await inspectSonos('http://192.168.10.2:1400')).id,'RINCON_A');
  xml='<manufacturer>Other</manufacturer><UDN>uuid:RINCON_A</UDN>';await assert.rejects(inspectSonos('http://192.168.10.2:1400'),/不是 Sonos/);
  xml='<manufacturer>Sonos</manufacturer><UDN>uuid:unrecognized</UDN>';await assert.rejects(inspectSonos('http://192.168.10.2:1400'),/不是 Sonos/);
  ok=false;await assert.rejects(inspectSonos('http://192.168.10.2:1400'),/不可用/);
});
