import test from 'node:test';
import assert from 'node:assert/strict';
import {assertQueueTrack,createKeyedMutationQueue,matchPlaylistQueue,remainingPlaylistIndices,replaceQueueSafely,replaceQueueTailSafely,requiresQueueRecheck,shuffledIndices,withoutSonosShuffle} from '../queue-safety.mjs';

test('queue mutations on one speaker serialize and recover after a failure',async()=>{
  const mutate=createKeyedMutationQueue(),events=[];
  let releaseFirst;
  let firstStarted;
  const started=new Promise(resolve=>{firstStarted=resolve;});
  const gate=new Promise(resolve=>{releaseFirst=resolve;});
  const first=mutate('living-room',async()=>{events.push('verify old row');firstStarted();await gate;events.push('move row');throw Error('Sonos rejected move');});
  const second=mutate('living-room',async()=>{events.push('verify current row');events.push('play row');});
  await started;
  assert.deepEqual(events,['verify old row']);
  releaseFirst();
  await assert.rejects(first,/Sonos rejected move/);
  await second;
  assert.deepEqual(events,['verify old row','move row','verify current row','play row']);
});

test('independent speakers can process queue mutations concurrently',async()=>{
  const mutate=createKeyedMutationQueue(),events=[];
  let releaseFirst;
  const gate=new Promise(resolve=>{releaseFirst=resolve;});
  const first=mutate('living-room',async()=>{events.push('living start');await gate;events.push('living end');});
  const second=mutate('bedroom',async()=>{events.push('bedroom run');});
  await second;
  assert.deepEqual(events,['living start','bedroom run']);
  releaseFirst();await first;
});

test('each activation can create a different complete playlist order',()=>{
  const source=[1,2,3,4,5];
  const first=shuffledIndices(source,()=>0);
  const second=shuffledIndices(source,end=>end-1);
  assert.deepEqual([...first].sort(),source);
  assert.deepEqual([...second].sort(),source);
  assert.notDeepEqual(first,second);
  assert.notDeepEqual(second,source);
  assert.deepEqual(source,[1,2,3,4,5]);
  assert.deepEqual(shuffledIndices(source,size=>size===2?0:size-1,[2,1,3,4,5]),source);
});

test('reshuffling keeps played tracks and current track out of the new tail',()=>{
  assert.deepEqual(remainingPlaylistIndices(6,2,[0,2,4]),[3,5,1]);
  assert.deepEqual(remainingPlaylistIndices(1,0,[0]),[]);
});

test('custom shuffle removes Sonos fixed shuffle without losing repeat settings',()=>{
  assert.equal(withoutSonosShuffle('SHUFFLE_NOREPEAT'),'NORMAL');
  assert.equal(withoutSonosShuffle('SHUFFLE'),'REPEAT_ALL');
  assert.equal(withoutSonosShuffle('SHUFFLE_REPEAT_ONE'),'REPEAT_ONE');
  assert.equal(withoutSonosShuffle('NORMAL'),'NORMAL');
});

test('a new random next track is ready before the old tail is removed',async()=>{
  const queue=['played','current','old-next','old-last'];
  const events=[];
  await replaceQueueTailSafely({
    appendFirst:async()=>{queue.push('random-next');events.push('append');return 5;},
    validateFirst:async number=>{assert.equal(number,5);assert.equal(queue[4],'random-next');},
    removeOldTail:async()=>{assert.equal(queue[1],'current');queue.splice(2,2);events.push('remove');},
    rollbackFirst:async()=>{throw Error('unexpected rollback');}
  });
  assert.deepEqual(queue,['played','current','random-next']);
  assert.deepEqual(events,['append','remove']);
});

test('a failed random tail switch preserves the old upcoming songs',async()=>{
  const queue=['current','old-next','old-last'];
  await assert.rejects(replaceQueueTailSafely({
    appendFirst:async()=>{queue.push('random-next');return 4;},
    validateFirst:async()=>{},
    removeOldTail:async()=>{throw Error('remove failed');},
    rollbackFirst:async()=>{assert.equal(queue.pop(),'random-next');}
  }),/remove failed/);
  assert.deepEqual(queue,['current','old-next','old-last']);
});

test('a mismatched staged next track is removed before touching the old tail',async()=>{
  const queue=['current','old-next'];
  await assert.rejects(replaceQueueTailSafely({
    appendFirst:async()=>{queue.push('wrong-track');return 3;},
    validateFirst:async()=>{throw Error('staged track differs');},
    removeOldTail:async()=>{throw Error('old tail must not be removed');},
    rollbackFirst:async()=>{assert.equal(queue.pop(),'wrong-track');}
  }),/staged track differs/);
  assert.deepEqual(queue,['current','old-next']);
});

test('a failed rollback reports both the queue error and cleanup failure',async()=>{
  await assert.rejects(replaceQueueTailSafely({
    appendFirst:async()=>3,
    validateFirst:async()=>{throw Error('staged track differs');},
    removeOldTail:async()=>{},
    rollbackFirst:async()=>{throw Error('speaker unavailable');}
  }),/staged track differs；新曲目清理失败：speaker unavailable/);
});

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
