'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {LocalSendService}=require('../src/service');

async function run(window,service,output){
  await fs.mkdir(output,{recursive:true});
  await require('./ui-smoke').run(window,service,path.join(output,'workflow'));
  const evaluate=code=>window.webContents.executeJavaScript(code);
  await evaluate("document.querySelector('#toast-root').replaceChildren()");
  const pause=()=>new Promise(r=>setTimeout(r,150));
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const capture=async name=>{await pause();const result=await window.webContents.capturePage({stayHidden:true});await fs.writeFile(path.join(output,name),result.toPNG());};
  const checks=[];
  const navigate=async page=>{await click(`[data-action="navigate"][data-page="${page}"]`);await pause();};
  service.updateSettings({alias:'A carefully named Windows PC with a long but recognizable device name'});
  service.addText('A message for UI layout validation.');
  service.selection.push({id:crypto.randomUUID(),name:'Project notes — a very long document filename with international characters 日本語 हिन्दी.pdf',size:128000,type:'file',mime:'application/pdf'});
  service.peers.set('ui-fixture',{id:'ui-fixture',alias:'A phone with a long, recognizable name that should wrap cleanly',deviceModel:'Android phone on the local network',deviceType:'mobile',host:'127.0.0.1',port:53317,protocol:'https',lastSeen:Date.now()});
  service.changed(true);await pause();
  for(const theme of ['light','dark']){
    service.updateSettings({theme});await pause();
    for(const [label,width,height,zoom]of [['regular',1160,790,1],['compact',820,610,1],['large',1440,900,1],['zoomed',1000,760,1.5]]){
      window.setSize(width,height);window.webContents.setZoomFactor(zoom);await pause();
      for(const page of ['receive','send','history','settings']){
        await navigate(page);
        const layout=await evaluate(`(()=>{
          const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&s.display!=='none'&&s.visibility!=='hidden';};
          const outside=[...document.querySelectorAll('#page button,#page input,#page select,#page .surface')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.left<70||r.right>innerWidth+1;}).map(e=>({tag:e.tagName,action:e.dataset.action,rect:e.getBoundingClientRect().toJSON()}));
          return {width:innerWidth,bodyWidth:document.documentElement.scrollWidth,pageWidth:document.querySelector('#page').scrollWidth,pageClient:document.querySelector('#page').clientWidth,scrollHeight:document.querySelector('#page-scroll').clientHeight,outside};
        })()`);
        assert.ok(layout.bodyWidth<=layout.width+1,`${theme}/${label}/${page} body overflows: ${JSON.stringify(layout)}`);
        assert.ok(layout.pageWidth<=layout.pageClient+1,`${theme}/${label}/${page} page overflows: ${JSON.stringify(layout)}`);
        assert.ok(layout.scrollHeight>120,`${theme}/${label}/${page} cannot scroll`);
        assert.deepEqual(layout.outside,[],`${theme}/${label}/${page} has clipped controls`);
        checks.push({theme,size:label,page,layout:'pass'});
        if(label==='regular'||label==='compact')await capture(`${theme}-${label}-${page}.png`);
      }
    }
  }
  window.webContents.setZoomFactor(1);window.setSize(1160,790);service.updateSettings({theme:'light'});await pause();
  await navigate('settings');
  await evaluate(`(()=>{const e=document.querySelector('#settings-alias');window.__focusedInput=e;e.focus();e.value='My draft stays in place';e.dispatchEvent(new Event('input',{bubbles:true}));e.setSelectionRange(3,8);})()`);
  for(let i=0;i<4;i++)service.changed(true);await pause();
  assert.equal(await evaluate(`document.activeElement===window.__focusedInput&&document.activeElement.value==='My draft stays in place'&&document.activeElement.selectionStart===3&&document.activeElement.selectionEnd===8`),true,'State updates disturbed editing');
  checks.push({interaction:'input identity, draft and cursor survive state updates',status:'pass'});
  await navigate('send');
  await evaluate(`(()=>{const b=document.querySelector('[data-action="text"]');b.focus();window.__modalOpener=b;b.click();})()`);await pause();
  assert.equal(await evaluate(`document.querySelector('#app').inert&&document.activeElement.id==='message-text'`),true,'Modal did not isolate/focus the form');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await pause();
  assert.equal(await evaluate(`!document.querySelector('#app').inert&&document.activeElement===window.__modalOpener`),true,'Modal did not restore keyboard focus');
  checks.push({interaction:'modal isolation, Escape and focus restoration',status:'pass'});
  await click('[data-action="manual"]');await pause();
  await capture('manual-dialog.png');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await pause();
  const peer=new LocalSendService({dataDir:path.join(output,'incoming-peer'),port:0,host:'127.0.0.1',discovery:false});await peer.start();
  try{
    const response=peer.request({...service.info(),host:'127.0.0.1'},'/prepare-upload',{body:{info:peer.info(),files:{long:{id:'long',fileName:'A long document name 日本語 हिन्दी with details that must remain readable in the approval dialog.pdf',size:0,fileType:'application/pdf'}}}}).then(()=>false,error=>error.status===403);
    for(let i=0;i<40&&!service.pending.size;i++)await pause();await pause();
    assert.ok(service.pending.size,'Incoming approval not displayed');await capture('incoming-long-name.png');
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await response,true,'Escape did not decline incoming transfer');
    checks.push({interaction:'real incoming approval with long filename and keyboard decline',status:'pass'});
  }finally{await peer.stop();}
  const contrast=await evaluate(`(()=>{
    const rgb=x=>x.match(/[\\d.]+/g).slice(0,3).map(Number);
    const luminance=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
    const root=getComputedStyle(document.documentElement),color=luminance(rgb(root.getPropertyValue('--muted').trim().startsWith('#')?getComputedStyle(document.querySelector('.nearby-subtitle')).color:root.color));
    return [...document.querySelectorAll('.nearby-subtitle,.selection-hint,.page-heading p')].map(e=>{let parent=e;while(parent&&getComputedStyle(parent).backgroundColor==='rgba(0, 0, 0, 0)')parent=parent.parentElement;const fg=luminance(rgb(getComputedStyle(e).color)),bg=luminance(rgb(getComputedStyle(parent||document.body).backgroundColor));return {text:e.innerText,ratio:(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)};});
  })()`);
  for(const item of contrast)assert.ok(item.ratio>=4.5,`Text contrast too low: ${JSON.stringify(item)}`);
  checks.push({interaction:'secondary text contrast meets 4.5:1',status:'pass'});
  await fs.writeFile(path.join(output,'audit.json'),JSON.stringify({passed:true,checks},null,2));
  console.log(`Windows UI audit passed: ${checks.length} layout and interaction checks.`);
}
module.exports={run};
