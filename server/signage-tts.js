"use strict";
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
function announcement(calls){
 if(calls.length!==1)return '화면의 성함과 배정 위치를 확인하시고 이동해 주세요.';
 const call=calls[0],no=Number(call.bedNo);
 const numbers=['','일','이','삼','사','오','육','칠','팔','구','십','십일','십이','십삼','십사','십오'];
 const destination=no>=101?numbers[no-100]+' 번 진료실':no===15?'스파인':numbers[no]+' 번 베드';
 return (call.speechName||call.displayName)+'님, '+destination+'로 들어와 주세요.';
}
async function synthesizeLocal(text){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'signage-tts-'));
 const output=path.join(directory,'voice.wav');
 try{
  await new Promise((resolve,reject)=>{
   const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'signage-tts.ps1'),'-OutputPath',output],{windowsHide:true,stdio:['pipe','ignore','ignore']});
   const timeout=setTimeout(()=>{child.kill();reject(Error('TTS timeout'));},15000);
   child.on('error',error=>{clearTimeout(timeout);reject(error);});
   child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('TTS generation failed'));});
   child.stdin.on('error',()=>{});
   child.stdin.end(Buffer.from(text,'utf8').toString('base64')+'\n');
  });
  return await fs.readFile(output);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}
function escapeXml(text){return String(text).replace(/[<>&"']/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[char]));}
async function synthesizeAzure(text,{key=process.env.AZURE_SPEECH_KEY,region=process.env.AZURE_SPEECH_REGION,request=fetch}={}){
 if(!key||!region||!/^[a-z0-9]+$/.test(region))throw Error('Azure Speech configuration missing or invalid');
 const response=await request(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,{
  method:'POST',signal:AbortSignal.timeout(8000),
  headers:{'Ocp-Apim-Subscription-Key':key,'Content-Type':'application/ssml+xml','X-Microsoft-OutputFormat':'riff-24khz-16bit-mono-pcm','User-Agent':'inhouse-signage'},
  body:`<speak version="1.0" xml:lang="ko-KR"><voice name="ko-KR-SunHiNeural"><prosody rate="-5%">${escapeXml(text)}</prosody></voice></speak>`
 });
 if(!response.ok)throw Error('Azure Speech HTTP '+response.status);
 const buffer=Buffer.from(await response.arrayBuffer());
 if(buffer.length<44||buffer.toString('ascii',0,4)!=='RIFF'||buffer.toString('ascii',8,12)!=='WAVE')throw Error('Azure Speech invalid audio');
 return buffer;
}
function createSynthesizer({azure=synthesizeAzure,local=synthesizeLocal,configured=()=>!!process.env.AZURE_SPEECH_KEY&&!!process.env.AZURE_SPEECH_REGION,warn=message=>console.warn(message)}={}){
 let retryAfter=0;
 return async text=>{
  if(configured()&&Date.now()>=retryAfter){
   try{return await azure(text);}catch(error){retryAfter=Date.now()+60000;warn('Azure Speech unavailable; using local voice for 60 seconds.');}
  }
  return local(text);
 };
}
const synthesize=createSynthesizer();
function createSpeechCache(generate=synthesize){
 const cache=new Map();let queue=Promise.resolve();
 return function getSpeech(text){
  const now=Date.now(),key=crypto.createHash('sha256').update(text).digest('hex');
  for(const [id,item] of cache)if(item.expires<now)cache.delete(id);
  if(cache.has(key))return cache.get(key).promise;
  if(cache.size>=32)return Promise.reject(Error('TTS queue full'));
  const promise=queue.then(()=>generate(text));
  queue=promise.catch(()=>{});
  cache.set(key,{promise,expires:now+1800000});
  promise.catch(()=>cache.delete(key));
  return promise;
 };
}
module.exports={announcement,synthesize,synthesizeAzure,createSynthesizer,createSpeechCache};
