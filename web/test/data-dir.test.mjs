import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('Linux/NAS data directory keeps history outside the code checkout',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sonos-data-test-'));
  try{
    execFileSync(process.execPath,['--input-type=module','-e',
      "import {recordPlay} from './play-history.mjs'; await recordPlay('test-account',{id:1,mid:'test-mid',title:'Test',artist:'Artist'});"
    ],{cwd:new URL('..',import.meta.url),env:{...process.env,SONOS_DATA_DIR:directory}});
    const history=JSON.parse(await readFile(path.join(directory,'.play-history.json'),'utf8'));
    assert.equal(history['test-account'][0].mid,'test-mid');
  }finally{await rm(directory,{recursive:true,force:true});}
});
