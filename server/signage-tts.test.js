const test=require('node:test'),assert=require('node:assert/strict');
const {announcement,createSpeechCache,synthesizeAzure,createSynthesizer}=require('./signage-tts');
test('announcement uses full names, Korean bed numbers and generic batch guidance',()=>{
 assert.equal(announcement([{displayName:'홍길동',bedNo:8}]),'홍길동님, 팔 번 베드로 들어와 주세요.');
 assert.equal(announcement([{displayName:'홍길동',bedNo:101}]),'홍길동님, 일 번 원장실로 들어와 주세요.');
 assert.equal(announcement([{},{}]),'화면의 성함과 배정 위치를 확인하시고 이동해 주세요.');
});
test('Azure request selects SunHi, escapes names and returns validated WAV',async()=>{
 const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);
 let captured;
 const result=await synthesizeAzure('홍<&길동',{key:'test-key',region:'koreacentral',request:async(url,options)=>{captured={url,options};return {ok:true,arrayBuffer:async()=>wav};}});
 assert.equal(result.toString('ascii',0,4),'RIFF');
 assert.equal(captured.url,'https://koreacentral.tts.speech.microsoft.com/cognitiveservices/v1');
 assert.match(captured.options.body,/ko-KR-SunHiNeural/);assert.match(captured.options.body,/홍&lt;&amp;길동/);
 assert.equal(captured.options.headers['Ocp-Apim-Subscription-Key'],'test-key');
 await assert.rejects(synthesizeAzure('test',{key:'test-key',region:'koreacentral',request:async()=>({ok:false,status:401})}),/HTTP 401/);
});
test('Azure failure falls back locally and avoids repeated failing requests',async()=>{
 let azureCalls=0,localCalls=0;
 const synth=createSynthesizer({configured:()=>true,azure:async()=>{azureCalls++;throw Error('network');},local:async()=>{localCalls++;return Buffer.from('local');},warn:()=>{}});
 assert.equal((await synth('one')).toString(),'local');await synth('two');
 assert.equal(azureCalls,1);assert.equal(localCalls,2);
 const success=createSynthesizer({configured:()=>true,azure:async()=>Buffer.from('azure'),local:async()=>{throw Error('should not run');}});
 assert.equal((await success('one')).toString(),'azure');
});
test('speech cache shares pending requests, serializes generation and retries failures',async()=>{
 let running=0,peak=0,count=0;
 const get=createSpeechCache(async text=>{running++;peak=Math.max(peak,running);count++;await new Promise(setImmediate);running--;if(text==='fail')throw Error('failed');return Buffer.from(text);});
 const [a,b]=await Promise.all([get('one'),get('one'),get('two')]);
 assert.equal(a,b);assert.equal(count,2);assert.equal(peak,1);
 await get('one');assert.equal(count,2);
 await assert.rejects(get('fail'));await assert.rejects(get('fail'));assert.equal(count,4);
});
