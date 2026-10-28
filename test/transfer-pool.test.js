'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parallelFiles,runTransfers}=require('../src/transfer-pool');

test('parallel capability must be an explicitly supported integer',()=>{
  for(const n of [undefined,null,0,-1,1.5,4,1000,'3',true,NaN])assert.equal(parallelFiles({parallelFiles:n}),1);
  assert.equal(parallelFiles(),1);assert.equal(parallelFiles({parallelFiles:2}),2);assert.equal(parallelFiles({parallelFiles:3}),3);
});

test('worker pool stops scheduling on failure and waits for open transfers to close',async()=>{
  const started=[],closed=[];let aborted=0,release;
  const held=new Promise(resolve=>{release=resolve;});
  const original=new Error('disk full');
  const result=runTransfers([0,1,2,3,4,5],3,async item=>{
    started.push(item);
    try {if(item===1)throw original;await held;}finally{closed.push(item);}
  },()=>{aborted++;release();});
  await assert.rejects(result,error=>error===original);
  assert.deepEqual(started,[0,1,2]);assert.equal(aborted,1);assert.equal(closed.length,3);
});
