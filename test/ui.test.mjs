import {test} from 'node:test';
import assert from 'node:assert/strict';
import client from '../client/index.js';
import {register} from '../server/index.js';
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
for(const available of [true,false])test('status UI Argon '+(available?'exhausted with reset':'unavailable'),async()=>{
 const el={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};
 client.init({CoreAPI:{escapeHtml:esc},ui:{addSettingsSection:fn=>fn(el)},settings:{get:()=>undefined},server:{call:async()=>({antigravity:{installed:true,loggedIn:true,version:'1.5.3',error:'<upstream>',pools:[{name:'Gemini 4 Argon',available,usedPct:100,remainingPct:0,exhausted:true,resetTime:'2026-11-11T00:00:00Z'}]}})}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(el.innerHTML,/Gemini 4 Argon:/);assert.match(el.innerHTML,available?/EXHAUSTED.*resets 2026-11-11/:/Gemini 4 Argon: unavailable/);assert.match(el.innerHTML,/&lt;upstream&gt;/);assert.match(el.innerHTML,/<option value="cli" selected>/);
});
test('all subscription kinds, capabilities and profile-independent defaults remain registered',()=>{
 const adapters=[];register({get:()=>{}},{llm:{kit:{LlmError:Error},registerAdapter:a=>adapters.push(a)},hooks:{add:()=>{}}});
 assert.deepEqual(adapters.map(a=>a.kind),['claude-subscription','codex-subscription','antigravity-subscription']);
 for(const a of adapters){assert.equal(a.capabilities.streaming,true);assert.equal(a.capabilities.vision,true);assert.equal(a.capabilities.reasoning,true);assert.equal(a.requiresBaseUrl,false);assert.equal(typeof a.chat,'function');assert.equal(typeof a.chatStream,'function');}
});
test('client binds model context before exposing the settings section',async()=>{
 const steps=[];const el={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};
 await client.init({CoreAPI:{escapeHtml:esc},ui:{addSettingsSection:fn=>{steps.push('section');fn(el);}},settings:{get:()=>undefined},server:{call:async(route)=>{steps.push(route);return {};}}});
 assert.equal(steps[0],'/model-context');assert.equal(steps[1],'section');
});
test('cold model discovery fails clearly before contacting the wrong backend',async()=>{
 const adapters=[];register({get:()=>{}},{llm:{kit:{LlmError:class extends Error{constructor(kind,message,opts){super(message);this.kind=kind;Object.assign(this,opts);}}},registerAdapter:a=>adapters.push(a)},hooks:{add:()=>{}}});
 await assert.rejects(adapters[2].listModels({id:'cold-profile'},null),e=>e.kind==='bad_request'&&e.status===400&&/model-context/.test(e.message));
});
for (const [saved,existing,expected] of [['direct',true,'direct'],['cli',true,'cli'],[null,true,'direct'],[null,false,'cli']]) {
    test(`mode initialization preserves ${saved || 'implicit'} selection with existing profiles ${existing}`, () => {
        const routes=new Map();const writes=[];const db={};
        register({get:(path,fn)=>routes.set(path,fn)},{
            llm:{kit:{LlmError:Error},registerAdapter:()=>{}},hooks:{add:()=>{}},
            settingValue:()=>saved,
            stores:{llmProfiles:{listProfiles:()=>existing?[{id:'old',kind:'antigravity-subscription'}]:[]},settings:{patchSettings:(got,values)=>{assert.equal(got,db);writes.push(values);}}},
        });
        routes.get('/model-context')({db},{json:()=>{}});
        if(saved) assert.equal(writes.length,0);
        else assert.deepEqual(writes,[{'ext:oauth-subscriptions:antigravityMode':expected}]);
    });
}
