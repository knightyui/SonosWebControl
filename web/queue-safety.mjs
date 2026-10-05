import {randomInt} from 'node:crypto';

export function createKeyedMutationQueue(){
  const pending=new Map();
  return (key,action)=>{
    const previous=pending.get(key)||Promise.resolve();
    const current=previous.catch(()=>{}).then(action);
    pending.set(key,current);
    void current.finally(()=>{if(pending.get(key)===current)pending.delete(key);}).catch(()=>{});
    return current;
  };
}

export function shuffledIndices(indices,choose=randomInt,avoid=indices){
  const result=[...indices];
  for(let end=result.length-1;end>0;end--){
    const pick=choose(end+1);
    if(!Number.isInteger(pick)||pick<0||pick>end)throw Error('随机数无效。');
    [result[end],result[pick]]=[result[pick],result[end]];
  }
  if(result.length>1&&result.every((item,index)=>item===avoid[index])){
    [result[0],result[1]]=[result[1],result[0]];
  }
  return result;
}

export function remainingPlaylistIndices(length,currentIndex,playedIndices=[]){
  const played=new Set(playedIndices);
  const result=[];
  for(let offset=1;offset<length;offset++){
    const index=(currentIndex+offset)%length;
    if(!played.has(index))result.push(index);
  }
  return result;
}

export function withoutSonosShuffle(mode){
  return ({SHUFFLE_NOREPEAT:'NORMAL',SHUFFLE:'REPEAT_ALL',SHUFFLE_REPEAT_ONE:'REPEAT_ONE'})[mode]||mode;
}

export function matchPlaylistQueue(playlistIds,queueIds){
  if(!playlistIds.length||playlistIds.length!==queueIds.length)return null;
  const positions=new Map();
  playlistIds.forEach((id,index)=>{
    if(!positions.has(id))positions.set(id,[]);
    positions.get(id).push(index);
  });
  const used=new Map(),order=[];
  for(const id of queueIds){
    const available=positions.get(id);
    const offset=used.get(id)||0;
    if(!available||offset>=available.length)return null;
    order.push(available[offset]);
    used.set(id,offset+1);
  }
  return order;
}

export function assertQueueTrack(actual,expected){
  if(!actual||actual.number!==expected.number||actual.key!==expected.key)
    throw Error('播放队列已变化，请刷新后重试。');
}

export function requiresQueueRecheck(previousUpdateId,currentUpdateId){
  return !previousUpdateId||!currentUpdateId||previousUpdateId!==currentUpdateId;
}

export async function replaceQueueSafely({oldCount,append,play,removeOld,removeStaged}){
  let stagedNumber;
  try{
    stagedNumber=await append();
    await play(stagedNumber);
  }catch(error){
    try{await removeStaged(stagedNumber);}catch(cleanupError){
      throw Error(`${error.message}；新曲目清理失败：${cleanupError.message}`,{cause:error});
    }
    throw error;
  }
  if(oldCount)await removeOld(oldCount);
  return stagedNumber;
}

export async function replaceQueueTailSafely({appendFirst,validateFirst,removeOldTail,rollbackFirst}){
  let stagedNumber;
  try{
    stagedNumber=await appendFirst();
    await validateFirst(stagedNumber);
    await removeOldTail();
  }catch(error){
    try{await rollbackFirst(stagedNumber);}catch(cleanupError){
      throw Error(`${error.message}；新曲目清理失败：${cleanupError.message}`,{cause:error});
    }
    throw error;
  }
  return stagedNumber;
}
