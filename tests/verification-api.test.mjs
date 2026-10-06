import test from 'node:test';
import assert from 'node:assert/strict';
import {HoyolabClient,dynamicSecret} from '../lib/hoyolab.mjs';

const account={uid:'123456789',region:'cn',server:'cn_gf01',cookie:'ltuid=10001; ltoken=synthetic-cookie-secret;'};
const challenge='a'.repeat(32),gt='b'.repeat(32),validate='c'.repeat(32);
const proof={geetest_challenge:challenge,geetest_validate:validate,geetest_seccode:validate+'|jordan'};
const response=(data,retcode=0)=>({ok:true,json:async()=>({retcode,data})});

test('manual verification uses fixed official endpoints, the same issued device and exact DS bytes',async()=>{
 const calls=[];let clock=1000000;
 const mys=new HoyolabClient({now:()=>clock,deviceFp:'issued-fp-for-test',fetch:async(url,options)=>{calls.push({url,options});return response(url.includes('createVerification')?{gt,challenge,new_captcha:1}:url.includes('verifyVerfication')?{challenge:'server-issued-grant'}:{stats:{active_day_number:1}})}});
 const started=await mys.createVerification(account);assert.equal(started.ok,true);assert.equal(started.data.new_captcha,true);assert.equal(started.device.fingerprint,'issued-fp-for-test');
 const submitted=await mys.submitVerification(account,proof,started.device);assert.equal(submitted.ok,true);assert.equal(JSON.stringify(submitted).includes('server-issued-grant'),false);
 assert.equal(calls[0].url,'https://bbs-api.miyoushe.com/misc/wapi/createVerification?gids=2&is_high=false');
 assert.equal(calls[1].url,'https://bbs-api.miyoushe.com/misc/wapi/verifyVerfication');
 assert.equal(calls[1].options.method,'POST');assert.equal(calls[1].options.body,JSON.stringify(proof));
 for(const {url,options} of calls){const [time,random]=options.headers.DS.split(',');assert.equal(options.headers.DS,dynamicSecret({query:new URL(url).search.slice(1),body:options.body||'',time:Number(time),random}));assert.equal(options.redirect,'error');assert.equal(options.headers['x-rpc-device_fp'],started.device.fingerprint);assert.equal(options.headers['x-rpc-device_id'],started.device.deviceId)}
 await mys.query('index',account);assert.equal(calls.at(-1).options.headers['x-rpc-challenge'],'server-issued-grant');
 await mys.query('index',{...account,cookie:'ltuid=10001; ltoken=changed-synthetic-token;'});assert.equal(calls.at(-1).options.headers['x-rpc-challenge'],undefined);
 clock+=300001;await mys.query('index',account);assert.equal(calls.at(-1).options.headers['x-rpc-challenge'],undefined);
});

test('manual verification rejects OS, device mismatch and malformed proof before any credential request',async()=>{
 const calls=[];const mys=new HoyolabClient({deviceFp:'issued-fp-for-test',fetch:async(...args)=>{calls.push(args);return response({gt,challenge,new_captcha:true})}});
 assert.equal((await mys.createVerification({...account,uid:'623456789',region:'os',server:'os_usa'})).code,'unsupported');
 const started=await mys.createVerification(account);assert.equal(started.ok,true);const count=calls.length;
 assert.equal((await mys.submitVerification(account,proof,{...started.device,deviceId:'changed-device'})).ok,false);
 assert.equal((await mys.submitVerification(account,{...proof,geetest_seccode:'incorrect'},started.device)).ok,false);
 assert.equal((await mys.submitVerification(account,{...proof,extra:'not-allowed'},started.device)).ok,false);
 assert.equal(calls.length,count);
});

test('invalid or rejected official manual verification responses never create an accepted grant',async()=>{
 let mode='malformed';const calls=[];
 const mys=new HoyolabClient({deviceFp:'issued-fp-for-test',fetch:async(url,options)=>{calls.push({url,options});if(url.includes('createVerification'))return response(mode==='malformed'?{gt:'</script>',challenge,new_captcha:true}:{gt,challenge,new_captcha:1});if(url.includes('verifyVerfication'))return response({},1034);return response({stats:{}})}});
 assert.equal((await mys.createVerification(account)).code,'invalid_response');mode='valid';const started=await mys.createVerification(account);
 const finished=await mys.submitVerification(account,proof,started.device);assert.equal(finished.code,'verification_required');
 await mys.query('index',account);assert.equal(calls.at(-1).options.headers['x-rpc-challenge'],undefined);
 assert.equal(calls.filter(x=>x.url.includes('verifyVerfication')).length,1);
});
