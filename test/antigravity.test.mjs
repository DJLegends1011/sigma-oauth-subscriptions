import {test,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,symlinkSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {detectAgyVersion,resolveAgyBinary,resolveCloudCodeModel,parseAgyQuotaPools,chatAgyCli,streamAgyCli,discoverAgyModels,listAgyCliModels,agyError,getAgyAuthToken,agyStatus} from '../server/antigravity-cli.js';
class LlmError extends Error {constructor(kind,message,opts={}){super(message);this.kind=kind;Object.assign(this,opts);}}
const root=mkdtempSync(join(tmpdir(),'sigma-agy-test-'));const bin=join(root,'agy.js');
const original={...process.env};const originalFetch=globalThis.fetch;process.env.HOME=root;
writeFileSync(bin,`#!/usr/bin/env node
if(process.argv.includes('--version')) {console.log(process.env.TEST_VERSION || '1.5.3');process.exit(0);}
if(process.argv.includes('models')){console.log('gemini-4-argon-low\\tGemini 4 Argon (Low)');process.exit(0);}
let input='';for await(const c of process.stdin)input+=c;
const emit=e=>console.log(JSON.stringify(e));
const mode=process.env.TEST_MODE;
if(mode==='capture' && !input.includes('Moon'))process.exit(9);
const args=process.argv.slice(2);const log=args[args.indexOf('--log-file')+1];
if(log) { const fs=await import('node:fs');fs.writeFileSync(log,mode==='fallback'?'Starting new conversation (agent=false)':'Starting new conversation (agent=true)'); }
emit({event:'init'});
if(mode==='unsafe-tool'){emit({event:'step_update',step_update:{step_type:'tool',tool_name:'run_command'}});setInterval(()=>{},1000);await new Promise(()=>{});}
if(mode==='failure'){emit({event:'result',result:{status:'ERROR',response:'',error:{code:429,status:'RESOURCE_EXHAUSTED',message:'quota exhausted'}}});process.exit(3);}
if(mode==='oauth'){emit({event:'result',result:{status:'ERROR',response:'',error:'OAuth authentication required'}});process.exit(1);}
if(mode==='response-error'){emit({event:'result',result:{status:'ERROR',response:'Unsupported client version'}});process.exit(1);}
if(mode==='stderr-quota'){console.error('AGY_ERROR: '+JSON.stringify({error_code:429,status:'RESOURCE_EXHAUSTED',short_error:'Individual quota reached'}));emit({event:'result',result:{status:'ERROR',error:'Individual quota reached'}});process.exit(3);}
if(mode==='broken')process.exit(4);
if(mode==='truncated'){emit({event:'step_update',step_update:{step_type:'agent_response',text_delta:'partial'}});process.exit(0);}
if(mode==='hang'){setInterval(()=>{},1000);await new Promise(()=>{});}
emit({event:'step_update',step_update:{step_type:'tool',tool_name:'manage_task',text_delta:'must not narrate'}});
emit({event:'step_update',step_update:{step_type:'agent_response',thinking_delta:'thought',text_delta:'Moon'}});
emit({event:'step_update',step_update:{step_type:'agent_response',state:'DONE',thinking:'thought'}});
emit({event:'result',result:{conversation_id:mode==='cleanup'?'11111111-2222-3333-4444-555555555555':undefined,status:'SUCCESS',response:'Moon',usage:{input_tokens:20,output_tokens:2,thinking_tokens:1,total_tokens:22}}});
`);chmodSync(bin,0o700);
after(()=>{globalThis.fetch=originalFetch;for(const k of Object.keys(process.env))if(!(k in original))delete process.env[k];Object.assign(process.env,original);rmSync(root,{recursive:true,force:true});});
let n=0,req,profile,calls;
const model='gemini-test';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const sse=(events)=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join(''));
beforeEach(()=>{process.env.AGY_PATH=bin;process.env.AGY_DATA_DIR=root;delete process.env.TEST_MODE;delete process.env.TEST_VERSION;profile={api_key:'ya29.test'+(++n)};req={model,messages:[{role:'system',content:'Character: the keeper.\nNarrate softly.'},{role:'user',content:'Moon'},{role:'assistant',content:'Silver.'},{role:'user',content:'Continue.'}],params:{temperature:0.7,topP:0.9,maxTokens:64,stop:['END']}};calls=[];
globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body),headers:options.headers});if(url.includes('loadCodeAssist'))return json({cloudaicompanionProject:'test-project'});if(url.includes('fetchAvailableModels'))return json({models:{[model]:{supportsImages:true,supportsThinking:true,maxTokens:10000}}});return sse([{response:{candidates:[{content:{parts:[{thought:true,text:'reason'},{text:'Moon',thoughtSignature:'signature'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:2,thoughtsTokenCount:1,totalTokenCount:23}}}]);};});
const chat=(settings={antigravityMode:'direct'})=>chatAgyCli(profile,req,settings,AbortSignal.timeout(3000),LlmError);
test('version comes from executable and refreshes after replacement',()=>{assert.equal(detectAgyVersion(),'1.5.3');process.env.TEST_VERSION='1.5.4';assert.equal(detectAgyVersion(),'1.5.4');process.env.TEST_VERSION='nonsense';assert.equal(detectAgyVersion(),null);});
test('Node shebang resolves through symlink using node; native Termux launcher stays intact',()=>{const link=join(root,'link');symlinkSync(bin,link);process.env.AGY_PATH=link;assert.equal(resolveAgyBinary().command,process.execPath);const sh=join(root,'termux-agy');writeFileSync(sh,'#!/data/data/com.termux/files/usr/bin/bash\n');chmodSync(sh,0o700);process.env.AGY_PATH=sh;assert.equal(resolveAgyBinary().command,sh);});
test('broken interpreter process error is reported',async()=>{const broken=join(root,'broken');writeFileSync(broken,'#!/sigma/nonexistent/interpreter\n');chmodSync(broken,0o700);process.env.AGY_PATH=broken;assert.equal(detectAgyVersion(),null);await assert.rejects(chat({antigravityMode:'cli'}),/ENOENT/);});
test('direct sends only intended prompt, roles, images and exact sampler limits',async()=>{req.messages[3].images=[{mediaType:'image/png',data:'aGVsbG8='}];const result=await chat();assert.equal(result.content,'Moon');assert.equal(result.reasoning,'reason');assert.equal(result.usage.total_tokens,23);const sent=calls.at(-1).body;assert.equal(sent.request.systemInstruction.parts[0].text,req.messages[0].content);assert.deepEqual(sent.request.contents.map(c=>c.role),['user','model','user']);assert.deepEqual(sent.request.contents[2].parts,[{inlineData:{mimeType:'image/png',data:'aGVsbG8='}},{text:'Continue.'}]);assert.deepEqual(sent.request.generationConfig,{maxOutputTokens:64,temperature:0.7,topP:0.9,stopSequences:['END']});assert.deepEqual(Object.keys(sent.request).sort(),['contents','generationConfig','systemInstruction']);assert.match(calls.at(-1).headers['User-Agent'],/^sigma-oauth-subscriptions\/1\.0\.0 \(installed-agy\/1\.5\.3;/);});
test('no synthetic start/continuation or default system prompt',async()=>{req.messages=[{role:'assistant',content:'A trailing prefill'}];await chat();const r=calls.at(-1).body.request;assert.equal(r.systemInstruction,undefined);assert.deepEqual(r.contents,[{role:'model',parts:[{text:'A trailing prefill'}]}]);});
test('reasoning budget retained without inflating output budget',async()=>{req.params.reasoning={enabled:true,budgetTokens:32};await chat();assert.deepEqual(calls.at(-1).body.request.generationConfig.thinkingConfig,{includeThoughts:true,thinkingBudget:32});});
test('unknown model never silently selects another family',async()=>{req.model='unknown';await assert.rejects(chat(),e=>e.kind==='bad_request'&&/not advertised/.test(e.message));assert.equal(calls.length,2);assert.throws(()=>resolveCloudCodeModel('',{rawMap:{}}));});
test('discovery caches per account, force refreshes, never fabricates CLI models',async()=>{const a=await discoverAgyModels({profile});assert.deepEqual(a.models.map(m=>m.id),[model]);await discoverAgyModels({profile});assert.equal(calls.length,2);await discoverAgyModels({profile,force:true});assert.equal(calls.length,3);await discoverAgyModels({profile:{api_key:'ya29.other'}});assert.equal(calls.length,5);});
for(const status of [401,403,429,500])test('generation HTTP '+status,async()=>{const mock=globalThis.fetch;globalThis.fetch=(url,opts)=>url.includes('streamGenerate')?json({error:{code:status,message:'upstream detail'}},status):mock(url,opts);await assert.rejects(chat(),e=>e.status===status&&e.retryable===false&&e.message.includes('upstream detail'));assert.equal(calls.filter(c=>c.url.includes('loadCodeAssist')).length,1);});
test('discovery authentication failure preserves HTTP code',async()=>{globalThis.fetch=async()=>json({error:'UNAUTHENTICATED'},401);await assert.rejects(chat(),e=>e.kind==='auth'&&e.status===401);});
test('network failure reports network error',async()=>{globalThis.fetch=async()=>{throw new TypeError('fetch failed',{cause:{code:'ENOTFOUND'}});};await assert.rejects(chat(),e=>e.kind==='network'&&/ENOTFOUND/.test(e.message));});
test('embedded SSE quota failure never returns successful reply',async()=>{const mock=globalThis.fetch;globalThis.fetch=(url,opts)=>url.includes('streamGenerate')?sse([{error:{code:429,status:'RESOURCE_EXHAUSTED',message:'quota exhausted'}}]):mock(url,opts);await assert.rejects(chat(),e=>e.kind==='quota'&&e.code===429);});
test('HTTP 200 unsupported version candidate is not emitted as narrator text',async()=>{const mock=globalThis.fetch;globalThis.fetch=(url,opts)=>url.includes('streamGenerate')?sse([{response:{candidates:[{content:{parts:[{text:'This version of Antigravity is no longer supported. Please update.'}]}}]}}]):mock(url,opts);const emitted=[];await assert.rejects(async()=>{for await(const p of streamAgyCli(profile,req,{antigravityMode:'direct'},null,LlmError))emitted.push(p);},/no longer supported/);assert.deepEqual(emitted,[]);});
test('incomplete direct stream throws',async()=>{const mock=globalThis.fetch;globalThis.fetch=(url,opts)=>url.includes('streamGenerate')?sse([{response:{candidates:[{content:{parts:[{text:'partial'}]}}]}}]):mock(url,opts);await assert.rejects(chat(),/without a terminal/);});
test('quota groups keep Argon independent, zero exhausted, reset and unavailable',()=>{const pools=parseAgyQuotaPools({'gemini-flash':{quotaInfo:{remainingFraction:0.8}},'gemini-4-argon-low':{quotaInfo:{remainingFraction:0,resetTime:'2026-11-11T00:00:00Z'}}});assert.equal(pools[0].remainingPct,80);assert.equal(pools[1].available,false);assert.equal(pools[2].remainingPct,0);assert.equal(pools[2].exhausted,true);assert.equal(pools[2].resetTime,'2026-11-11T00:00:00Z');});
test('quota summary windows take precedence over per-model snapshots',()=>{const p=parseAgyQuotaPools({}, {buckets:[{modelId:'gemini-4-argon-low',remainingFraction:1}],groups:[{displayName:'Gemini 4 Argon',buckets:[{window:'weekly',remainingFraction:0,resetTime:'later'},{window:'5h',remainingFraction:0.5}]}]})[2];assert.equal(p.remainingPct,0);assert.equal(p.windows.length,2);assert.equal(p.resetTime,'later');});
test('quota missing fraction is unavailable, never fabricated 100 percent',()=>assert.equal(parseAgyQuotaPools({}, {buckets:[{modelId:'gemini-4-argon-low'}]})[2].available,false));
test('subprocess stdin, agent-only streaming, reasoning, usage',async()=>{process.env.TEST_MODE='capture';const r=await chat({antigravityMode:'cli'});assert.equal(r.content,'Moon');assert.equal(r.reasoning,'thought');assert.equal(r.usage.total_tokens,22);assert.equal(r.usage.completion_tokens,2);});
for(const [mode,pattern]of [['failure',/429/],['oauth',/OAuth/],['response-error',/Unsupported client/],['broken',/exited/],['truncated',/ended without a reply/],['stderr-quota',/RESOURCE_EXHAUSTED/]])test('subprocess failure '+mode,async()=>{process.env.TEST_MODE=mode;await assert.rejects(chat({antigravityMode:'cli'}),pattern);});
test('subprocess abort never returns successful completion',async()=>{process.env.TEST_MODE='hang';const controller=new AbortController();const work=chatAgyCli(profile,req,{antigravityMode:'cli'},controller.signal,LlmError);setTimeout(()=>controller.abort(),80);await assert.rejects(work,e=>e.name==='AbortError');});
test('CLI mode lists actual CLI IDs separately from CloudCode',async()=>{assert.deepEqual(await listAgyCliModels(profile,{antigravityMode:'cli'}),[{id:'gemini-4-argon-low'}]);assert.deepEqual((await listAgyCliModels(profile,{antigravityMode:'direct'})).map(m=>m.id),[model]);});
test('inherited non-Google API key is ignored, missing login returns auth error',async()=>{assert.equal(await getAgyAuthToken({api_key:'sk-other'}),null);profile={api_key:'sk-other'};await assert.rejects(chat(),e=>e.kind==='auth');});
test('quota exhaustion preserves structured details and disables retry',()=>{const e=agyError({error_code:429,status:'RESOURCE_EXHAUSTED',message:'Individual quota reached'},LlmError,429);assert.equal(e.kind,'quota');assert.equal(e.retryable,false);assert.equal(e.status,429);});
test('explicit missing executable does not silently select another installation',async()=>{process.env.AGY_PATH=join(root,'missing');assert.equal(resolveAgyBinary(),null);assert.equal(detectAgyVersion(),null);await assert.rejects(chat({antigravityMode:'cli'}),/not found/);});
test('Gemini 3 reasoning effort is retained as thinking level',async()=>{req.model='gemini-3.8-flash';req.params.reasoning={effort:'low'};const mock=globalThis.fetch;globalThis.fetch=(url,opts)=>url.includes('fetchAvailableModels')?json({models:{[req.model]:{supportsThinking:true}}}):mock(url,opts);await chat();assert.equal(calls.at(-1).body.request.generationConfig.thinkingConfig.thinkingLevel,'LOW');});
test('split unsupported-version candidate is withheld from narration',async()=>{const mock=globalThis.fetch;globalThis.fetch=(url,opts)=>url.includes('streamGenerate')?sse(['This version of ','Antigravity is no longer supported. Please update.'].map(text=>({response:{candidates:[{content:{parts:[{text}]}}]}}))):mock(url,opts);const out=[];await assert.rejects(async()=>{for await(const p of streamAgyCli(profile,req,{antigravityMode:'direct'},null,LlmError))out.push(p);},/no longer supported/);assert.deepEqual(out,[]);});
test('multiline SSE frame is parsed without losing streaming content',async()=>{const mock=globalThis.fetch;globalThis.fetch=(url,opts)=>url.includes('streamGenerate')?new Response('data: {"response":\r\ndata: {"candidates":[{"content":{"parts":[{"text":"Moon"}]},"finishReason":"STOP"}]}}\r\n\r\n'):mock(url,opts);assert.equal((await chat()).content,'Moon');});
test('malformed SSE is a failure',async()=>{const mock=globalThis.fetch;globalThis.fetch=(url,opts)=>url.includes('streamGenerate')?new Response('data: not-json\n\n'):mock(url,opts);await assert.rejects(chat(),/Malformed/);});
test('quota status reads actual summary, renders Argon unavailable when absent',async()=>{writeFileSync(join(root,'antigravity-oauth-token'),JSON.stringify({token:{access_token:'ya29.status',expiry:'2099-01-01T00:00:00Z'}}));const mock=globalThis.fetch;globalThis.fetch=(url,opts)=>url.includes('retrieveUserQuotaSummary')?json({groups:[{displayName:'Gemini 4 Argon',buckets:[{window:'weekly',remainingFraction:0,resetTime:'2026-11-11T00:00:00Z'}]}]}):url.includes('retrieveUserQuota')?json({buckets:[]}):mock(url,opts);const status=await agyStatus({antigravityMode:'direct'});assert.equal(status.pools[2].exhausted,true);assert.equal(status.pools[0].available,false);rmSync(join(root,'antigravity-oauth-token'));});
test('invalid token limit fails instead of expanding the requested budget',async()=>{req.params.maxTokens=0;await assert.rejects(chat(),e=>e.kind==='bad_request'&&e.status===400);});
test('CLI image input fails clearly instead of silently dropping the image',async()=>{req.messages[3].images=[{mediaType:'image/png',data:'aGVsbG8='}];await assert.rejects(chat({antigravityMode:'cli'}),e=>e.kind==='bad_request'&&/text-only/.test(e.message));});
test('deadline failure remains distinct from quota/auth',async()=>{globalThis.fetch=async()=>{throw new DOMException('expired','TimeoutError');};await assert.rejects(chat(),e=>e.kind==='timeout');});
test('one OAuth refresh retries discovery with the new token',async()=>{
 const token=join(root,'antigravity-oauth-token');writeFileSync(token,JSON.stringify({token:{access_token:'ya29.old',refresh_token:'test-refresh',expiry:'2099-01-01T00:00:00Z'}}));profile={};let refreshes=0;const mock=globalThis.fetch;process.env.AGY_OAUTH_CLIENT_ID='fixture-client';process.env.AGY_OAUTH_CLIENT_SECRET='fixture-secret';
 globalThis.fetch=(url,opts)=>{if(url.includes('oauth2.googleapis.com')){refreshes++;return json({access_token:'ya29.new',expires_in:3600});}if(url.includes('loadCodeAssist')&&opts.headers.Authorization==='Bearer ya29.old')return json({error:'UNAUTHENTICATED'},401);return mock(url,opts);};
 try {assert.equal((await chat()).content,'Moon');assert.equal(refreshes,1);assert.equal(calls.at(-1).headers.Authorization,'Bearer ya29.new');} finally {rmSync(token);delete process.env.AGY_OAUTH_CLIENT_ID;delete process.env.AGY_OAUTH_CLIENT_SECRET;}
});
test('account bootstrap honors saved CLI mode before the first generation',async()=>{
 const {register}=await import('../server/index.js');const routes=new Map(),adapters=[];const db={};
 register({get:(p,fn)=>routes.set(p,fn)},{llm:{kit:{LlmError},registerAdapter:a=>adapters.push(a)},hooks:{add:()=>{}},stores:{llmProfiles:{listProfiles:got=>{assert.equal(got,db);return[{id:'existing',kind:'antigravity-subscription'}];}}},setting:(got,key)=>{assert.equal(got,db);return key==='antigravityMode'?'cli':undefined;}});
 routes.get('/model-context')({db},{json:v=>assert.deepEqual(v,{ok:true})});
 const models=await adapters[2].listModels({id:'existing'});assert.equal(models[0].id,'gemini-4-argon-low');assert.equal(calls.length,0);
});

test('account-bound direct discovery reports missing upstream project as upstream',async()=>{
 const {register}=await import('../server/index.js');const routes=new Map(),adapters=[],db={};
 register({get:(p,fn)=>routes.set(p,fn)},{llm:{kit:{LlmError},registerAdapter:a=>adapters.push(a)},hooks:{add:()=>{}},stores:{llmProfiles:{listProfiles:()=>[{id:'draft-base',kind:'openai'}]}},setting:()=> 'direct'});
 routes.get('/model-context')({db},{json:()=>{}});globalThis.fetch=async()=>json({});
 await assert.rejects(adapters[2].listModels({...profile,id:'draft-base'}),e=>e.kind==='upstream'&&/no project/.test(e.message));
});

test('subprocess deletes only its own SQLite/protobuf conversation and sidecars',async()=>{
 const id='11111111-2222-3333-4444-555555555555',dir=join(root,'conversations'),brain=join(root,'brain',id);
 mkdirSync(dir,{recursive:true});mkdirSync(brain,{recursive:true});
 const suffixes=['.pb','.db','.db-wal','.db-shm','.db-journal'];
 for(const suffix of suffixes)writeFileSync(join(dir,id+suffix),'test artifact');
 const existing=join(dir,'22222222-2222-3333-4444-555555555555.db');writeFileSync(existing,'existing conversation');
 process.env.TEST_MODE='cleanup';await chat({antigravityMode:'cli'});
 for(const suffix of suffixes)assert.equal(existsSync(join(dir,id+suffix)),false);
 assert.equal(existsSync(brain),false);assert.equal(existsSync(existing),true);
});

test('upstream fallback protection rejects a default-agent launch',async()=>{process.env.TEST_MODE='fallback';await assert.rejects(chat({antigravityMode:'cli'}),/fell back to its full coding agent/);});
test('upstream tool guard rejects command execution',async()=>{process.env.TEST_MODE='unsafe-tool';await assert.rejects(chat({antigravityMode:'cli'}),/tried to use a tool/);});
test('CLI mode enforces stops across the upstream completion writer',async()=>{req.params.stop=['on'];assert.equal((await chat({antigravityMode:'cli'})).content,'Mo');});
test('CLI port retains upstream invalid-model HTTP classification',async()=>{req.model='bad model; echo';await assert.rejects(chat({antigravityMode:'cli'}),e=>e.kind==='bad_request'&&e.status===400);});
test('missing adapter mode now selects the isolated CLI',async()=>{const result=await chatAgyCli(profile,req,{},AbortSignal.timeout(3000),LlmError);assert.equal(result.content,'Moon');assert.equal(calls.length,0);});
