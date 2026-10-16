import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bindBackdropDismiss} from '../public/dialog-interactions.mjs';

function fixture(){
  const listeners=new Map();
  const dialog={
    open:true,bounds:{left:0,right:402,top:450,bottom:874},
    getBoundingClientRect(){return this.bounds;},
    addEventListener(type,handler){listeners.set(type,handler);},
    close(){this.open=false;listeners.get('close')?.();}
  };
  bindBackdropDismiss(dialog);
  const emit=(type,overrides={})=>listeners.get(type)?.({target:dialog,clientX:200,clientY:400,button:0,detail:1,...overrides});
  return {dialog,emit};
}

test('editing a time or minute field cannot dismiss a sheet that moves on focus',()=>{
  for(const type of ['time','number']){
    const {dialog,emit}=fixture();
    emit('pointerdown',{target:{type},clientY:700});
    dialog.bounds={left:0,right:402,top:8,bottom:420};
    // Safari may retarget the click to the dialog after the input moves away.
    emit('click',{clientY:700});
    assert.equal(dialog.open,true);
  }
});

test('a gesture beginning on the sheet stays open when keyboard layout changes',()=>{
  const {dialog,emit}=fixture();
  emit('pointerdown',{clientY:500});
  dialog.bounds={left:0,right:402,top:8,bottom:420};
  emit('click',{clientY:500});
  assert.equal(dialog.open,true);
});

test('a normal backdrop tap still closes the sheet',()=>{
  const {dialog,emit}=fixture();
  emit('pointerdown');emit('click');
  assert.equal(dialog.open,false);
});

test('an outside tap still closes when blur moves the sheet underneath the finger',()=>{
  const {dialog,emit}=fixture();
  emit('pointerdown');
  dialog.bounds={left:0,right:402,top:350,bottom:874};
  emit('click',{target:{tagName:'FIELDSET'}});
  assert.equal(dialog.open,false);
});

test('a backdrop gesture released inside or canceled does not close',()=>{
  for(const canceled of [false,true]){
    const {dialog,emit}=fixture();
    emit('pointerdown');
    if(canceled)emit('pointercancel');
    emit('click',canceled?{}:{clientY:500});
    assert.equal(dialog.open,true);
  }
});

test('keyboard activation and stale gestures after reopening cannot dismiss',()=>{
  const {dialog,emit}=fixture();
  emit('pointerdown');emit('click',{detail:0});
  assert.equal(dialog.open,true);
  emit('pointerdown');dialog.close();dialog.open=true;
  emit('click');
  assert.equal(dialog.open,true);
});

test('all dialogs use the guarded backdrop interaction and the module is served',async()=>{
  const [app,server]=await Promise.all([
    readFile(new URL('../public/app.js',import.meta.url),'utf8'),
    readFile(new URL('../server.mjs',import.meta.url),'utf8')
  ]);
  assert.match(app,/from '\.\/dialog-interactions\.mjs'/);
  assert.match(app,/for\(const id of dialogIds\)\{[\s\S]*?bindBackdropDismiss\(dialog\)/);
  assert.match(server,/'playlist-cache\.mjs','dialog-interactions\.mjs','style\.css'/);
});
