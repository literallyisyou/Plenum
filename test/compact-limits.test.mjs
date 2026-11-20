import assert from 'node:assert/strict';
import test from 'node:test';
import { setToken } from '../lib/auth.mjs';
import { assertInputFits, cliPromptText, codexCompactArgs, compactDue, compactPolicy,
  defaultValue, measureInput, roomOf, summaryChunks } from '../lib/compact-limits.mjs';
import { routes } from '../lib/routes/compact-limits.mjs';

const astra = 'codex:gpt-6.2-astra';
const future = 'codex:future-window';
const chat = (role, content) => ({ role, content, kind: 'chat' });

test('the built-in target covers existing and future models with a bounded estimate', () => {
  assert.equal(defaultValue({}),500_000);
  assert.equal(compactPolicy(astra,{cli:true},{}).effective,500_000);
  const neon = compactPolicy('antigravity:gemini-4-neon-high', {cli:true}, {});
  assert.equal(neon.room.contextTokens, 512_000);
  assert.equal(neon.room.estimated, false);
  assert.equal(neon.effective, 496_000);
  assert.deepEqual(codexCompactArgs(astra,{}),['-c','model_auto_compact_token_limit=500000']);
  const unknown = compactPolicy(future,{cli:true},{});
  assert.equal(unknown.target,500_000);
  assert.equal(unknown.room.estimated,true);
  assert.ok(unknown.effective < 32_768);
  assert.equal(compactPolicy(future,{},{compactDefault:20_000}).effective,20_000);
  assert.equal(compactPolicy(astra,{},{compactDefault:'off'}).effective,'off');
  const override = {compactDefault:'off',compactAt:{[astra]:100_000,[future]:'off'}};
  assert.equal(compactPolicy(astra,{},override).effective,100_000);
  assert.equal(compactPolicy(future,{},override).source,'model');
  assert.deepEqual(codexCompactArgs(future,override),[]);
});

test('fresh CLI transport preserves history past the old caps and preflights actual rendered input', () => {
  const prior = chat('user','A'.repeat(180_000)+'🙂-first-tail');
  const reply = chat('assistant','B'.repeat(1_330_000)+'🙂-second-tail');
  const messages = [prior,reply,chat('user','current')];
  const prompt = cliPromptText(astra,'instructions',messages);
  assert.equal(Buffer.byteLength(prompt),measureInput('instructions',messages,{cli:true}).bytes);
  assert.ok(prompt.includes('🙂-first-tail'));
  assert.ok(prompt.includes('🙂-second-tail'));
  assert.ok(prompt.endsWith('current'));
  const input = {ref:astra,messages,log:[prior,reply],system:'instructions',cli:true,st:{}};
  assert.equal(compactDue(input).due,true);
  assert.equal(compactDue({...input,native:true}).due,false);
  assert.equal(compactDue({...input,st:{compactDefault:'off'}}).due,false);
});

test('budget errors distinguish oversized current input and retained history', () => {
  const max = roomOf(future,{cli:true}).maxBytes;
  const current = chat('user','x'.repeat(max));
  assert.equal(assertInputFits(future,'',[current],{cli:true}).bytes,max);
  assert.throws(()=>cliPromptText(future,'system',[current]),{code:'input_budget',message:/current message/});
  const turn = chat('user','retry');
  assert.throws(()=>cliPromptText(future,'',[current,turn]),{code:'input_budget',message:/Compact the conversation/});
  assert.equal(compactDue({ref:future,log:[current],messages:[current,turn],cli:true,st:{}}).due,true);
});

test('summary segments retain chronological content, tools and valid Unicode within budget', () => {
  const first = '🙂'.repeat(140)+' first-tail';
  const history = [chat('user',first),{...chat('assistant','reply-tail'),tools:[{name:'read',summary:'source',ok:true}]}];
  const chunks = summaryChunks(history,256);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk=>Buffer.byteLength(chunk)<=256 && !chunk.includes('�')));
  assert.ok(chunks.join('').includes(first));
  assert.match(chunks.join(''),/\[read: source\]\nreply-tail/);
  assert.throws(()=>summaryChunks(history,256,1),/No messages were replaced/);
});

test('authenticated settings validate before saving and restore settings after a failed save', async () => {
  const token = 'a'.repeat(64);
  setToken(token,'generated');
  const st = {model:astra,compactAt:{[astra]:'off'},unrelated:true};
  let saves = 0;
  let fail = false;
  const store = {get:()=>st,async saveOrFail() { saves++; if (fail) throw new Error('fixture save failure'); }};
  const httpError = (status,message)=>Object.assign(new Error(message),{status});
  const call = (method,body,headers={'x-plenum-token':token},query='') => routes.find(route=>route.method===method)
    .handler({req:{headers},url:new URL('http://localhost/api/compact-limits'+query),store,httpError,
      readBody:async()=>body,json:(_res,status,value)=>({status,value})});
  await assert.rejects(call('POST',{defaultValue:400_000},{}),{status:401});
  await assert.rejects(call('POST',{defaultValue:400_000,resetOverrides:'yes'}),{status:400});
  assert.equal(saves,0);
  fail = true;
  await assert.rejects(call('POST',{defaultValue:400_000,resetOverrides:true}),/fixture save failure/);
  assert.deepEqual(st,{model:astra,compactAt:{[astra]:'off'},unrelated:true});
  fail = false;
  await call('POST',{defaultValue:400_000});
  assert.deepEqual(st.compactAt,{[astra]:'off'});
  await call('POST',{ref:astra,value:null});
  const result = await call('GET',null,undefined,'?ref='+encodeURIComponent(future));
  assert.equal(result.value.model.target,400_000);
  assert.equal(result.value.model.source,'global');
  await call('POST',{defaultValue:null,resetOverrides:true});
  assert.equal(st.compactDefault,500_000);
  assert.deepEqual(st.compactAt,{});
});
