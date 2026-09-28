import test from 'node:test';
import assert from 'node:assert/strict';
import {assessTransport,createOperationTracker,seconds} from '../public/transport-sync.mjs';

test('a seek stays smooth while Sonos reports the old position',()=>{
  const expected={playing:true,position:90,startedAt:1000,requireTrackChange:false};
  assert.deepEqual(assessTransport({playing:true,position:'0:10',duration:'4:00'},expected,4000),{confirmed:false,displayPosition:93});
  assert.equal(assessTransport({playing:true,position:'1:33',duration:'4:00'},expected,4000).confirmed,true);
  assert.equal(seconds('1:02:03'),3723);
});

test('next does not settle on a still playing previous track',()=>{
  const expected={playing:true,position:null,startedAt:1000,requireTrackChange:true,previousTrack:2,previousSongId:22,previousPosition:85};
  assert.equal(assessTransport({playing:true,track:2,songId:22,position:'1:26'},expected,1500).confirmed,false);
  assert.equal(assessTransport({playing:true,track:3,songId:33,position:'0:00'},expected,1500).confirmed,true);
  assert.equal(assessTransport({playing:true,track:2,songId:22,position:'0:00'},expected,1500).confirmed,true);
});

test('pause and resume confirm only after the transport state changes',()=>{
  const resume={playing:true,position:null,startedAt:1000,requireTrackChange:false};
  assert.equal(assessTransport({playing:false,position:'1:10'},resume,1200).confirmed,false);
  assert.equal(assessTransport({playing:true,position:'1:11'},resume,1200).confirmed,true);
  const pause={...resume,playing:false};
  assert.equal(assessTransport({playing:true,position:'1:12'},pause,1300).confirmed,false);
  assert.equal(assessTransport({playing:false,position:'1:12'},pause,1300).confirmed,true);
});

test('an older control response cannot finish a newer control operation',()=>{
  const tracker=createOperationTracker();
  const first=tracker.begin();
  assert.equal(tracker.isCurrent(first),true);
  const second=tracker.begin();
  assert.equal(tracker.isCurrent(first),false);
  assert.equal(tracker.isCurrent(second),true);
});
