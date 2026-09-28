import test from 'node:test';
import assert from 'node:assert/strict';
import {assertQueueTrack,matchPlaylistQueue,replaceQueueSafely,requiresQueueRecheck} from '../queue-safety.mjs';

test('reuses a complete queue after restart, including shuffle and duplicate songs',()=>{
  assert.deepEqual(matchPlaylistQueue([11,22,11,33],[33,11,22,11]),[3,0,1,2]);
  assert.deepEqual(matchPlaylistQueue([11,22],[11,22]),[0,1]);
  assert.equal(matchPlaylistQueue([11,22],[11]),null);
  assert.equal(matchPlaylistQueue([11,22],[11,33]),null);
});

test('rechecks a cached queue only when its version is unknown or changed',()=>{
  assert.equal(requiresQueueRecheck('41','41'),false);
  assert.equal(requiresQueueRecheck('41','42'),true);
  assert.equal(requiresQueueRecheck('41',''),true);
  assert.equal(requiresQueueRecheck('','41'),true);
});

test('rejects a queue row when its position has been replaced',()=>{
  assert.doesNotThrow(()=>assertQueueTrack({number:4,key:'current'},{number:4,key:'current'}));
  assert.throws(()=>assertQueueTrack({number:4,key:'replacement'},{number:4,key:'current'}),/已变化/);
  // A non-QQ track has no QQ song ID; its content fingerprint must still protect edits.
  assert.throws(()=>assertQueueTrack({number:4,key:'other-stream'},{number:4,key:'original-stream'}),/已变化/);
  assert.throws(()=>assertQueueTrack({number:5,key:'current'},{number:4,key:'current'}),/已变化/);
  assert.throws(()=>assertQueueTrack(null,{number:4,key:'current'}),/已变化/);
});

test('cleans up a song added before an enqueue response fails',async()=>{
  const queue=['old'];
  await assert.rejects(replaceQueueSafely({
    oldCount:1,
    append:async()=>{queue.push('new');throw Error('reply lost');},
    play:async()=>{throw Error('must not play after an append error');},
    removeOld:async()=>{throw Error('must not remove the old queue');},
    removeStaged:async number=>{assert.equal(number,undefined);assert.equal(queue.pop(),'new');}
  }),/reply lost/);
  assert.deepEqual(queue,['old']);
});

test('keeps the original queue if the new song cannot play',async()=>{
  const queue=['old-1','old-2'];
  await assert.rejects(replaceQueueSafely({
    oldCount:2,
    append:async()=>{queue.push('new');return 3;},
    play:async()=>{throw Error('play failed');},
    removeOld:async()=>{throw Error('old queue must stay');},
    removeStaged:async()=>{assert.equal(queue.pop(),'new');}
  }),/play failed/);
  assert.deepEqual(queue,['old-1','old-2']);
});

test('starts the new song before removing old tracks',async()=>{
  const queue=['old-1','old-2'];
  let playing='old-1';
  const number=await replaceQueueSafely({
    oldCount:2,
    append:async()=>{queue.push('new');return 3;},
    play:async position=>{assert.equal(queue[position-1],'new');playing='new';},
    removeOld:async count=>{assert.equal(playing,'new');queue.splice(0,count);},
    removeStaged:async()=>{throw Error('successful playback must not roll back');}
  });
  assert.equal(number,3);
  assert.deepEqual(queue,['new']);
});

test('leaves old tracks in place if cleanup fails after playback',async()=>{
  const queue=['old','new'];
  await assert.rejects(replaceQueueSafely({
    oldCount:1,append:async()=>2,play:async()=>{},
    removeOld:async()=>{throw Error('cleanup failed');},
    removeStaged:async()=>{throw Error('should not remove playing song');}
  }),/cleanup failed/);
  assert.deepEqual(queue,['old','new']);
});
