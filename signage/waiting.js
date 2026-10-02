(function () {
  "use strict";
  var stage=document.getElementById('stage'), timer, lastCall='', audio, enabled=true, lastSoundCall='', chimeBuffer, chimeLoading=false, soundSources=[], speechGroup='', speechCalls=[], speechBufferPromise;
  function displayName(call){return String(call.displayName||call.speechName||call.maskedName||'')+'님';}
  function unlockAudio(){
    var Audio=window.AudioContext||window.webkitAudioContext;
    if(!Audio)return;
    try{
      audio=audio||new Audio();if(audio.state!=='running')audio.resume().catch(function(){});
      if(!chimeBuffer&&!chimeLoading){
        chimeLoading=true;
        fetch('assets/call-ding-dong.wav',{cache:'no-store'}).then(function(response){if(!response.ok)throw Error('chime');return response.arrayBuffer();}).then(function(buffer){
          audio.decodeAudioData(buffer,function(decoded){chimeBuffer=decoded;chimeLoading=false;},function(){chimeLoading=false;});
        }).catch(function(){chimeLoading=false;});
      }
    }catch(error){}
  }
  document.addEventListener('click',unlockAudio);
  document.addEventListener('touchend',unlockAudio);
  document.addEventListener('keydown',unlockAudio);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)unlockAudio();});
  unlockAudio();
  function prepareSpeech(group){
    speechBufferPromise=fetch('/signage/speech?group='+encodeURIComponent(group),{cache:'no-store'}).then(function(response){
      if(!response.ok)throw Error('speech');return response.arrayBuffer();
    }).then(function(buffer){return new Promise(function(resolve,reject){audio.decodeAudioData(buffer,resolve,reject);});}).catch(function(){return null;});
  }
  function announce(group){
    if(!speechBufferPromise)return;
    speechBufferPromise.then(function(buffer){
      if(!buffer||group!==speechGroup||!audio||audio.state!=='running')return;
      var source=audio.createBufferSource();source.buffer=buffer;source.connect(audio.destination);
      soundSources.push(source);
      source.onended=function(){source.disconnect();soundSources=soundSources.filter(function(item){return item!==source;});};
      source.start();
    });
  }
  function chime(group){
    if(!enabled||!audio||audio.state!=='running'||!chimeBuffer)return false;
    var source=audio.createBufferSource();source.buffer=chimeBuffer;source.connect(audio.destination);
    soundSources.push(source);
    source.onended=function(){source.disconnect();soundSources=soundSources.filter(function(item){return item!==source;});announce(group);};
    source.start();return true;
  }
  function clearCall(){var wasCalling=stage.classList.contains('is-calling');speechGroup='';speechCalls=[];speechBufferPromise=null;if(window.speechSynthesis)window.speechSynthesis.cancel();soundSources.forEach(function(source){try{source.stop();}catch(error){}});soundSources=[];stage.classList.remove('is-calling','is-group-calling');document.getElementById('callingMessage').hidden=true;document.getElementById('groupCalling').hidden=true;if(wasCalling&&window.restoreSignageAdvertising)window.restoreSignageAdvertising();document.querySelectorAll('video,audio').forEach(function(media){if(media.dataset.callVolume!==undefined){media.volume=Number(media.dataset.callVolume);delete media.dataset.callVolume;}});}
  async function refresh(){
    try{
      var controller=new AbortController(),timeout=setTimeout(function(){controller.abort();},5000);
      var response;
      try{response=await fetch('/signage/status',{cache:'no-store',signal:controller.signal});}finally{clearTimeout(timeout);}
      if(!response.ok)throw Error('status');var data=await response.json();
      document.getElementById('connectionStatus').textContent='';
      clearTimeout(timer);
      if(data.active){
        document.getElementById('callingName').textContent=displayName(data.active);
        document.getElementById('callingDestination').textContent=data.active.bedLabel;
        var calls=[data.active],groupKey=data.active.groupId||data.active.id;
        document.getElementById('callingMessage').hidden=false;
        document.getElementById('groupCalling').hidden=true;
        stage.classList.add('is-calling');stage.classList.remove('is-group-calling');
        if(lastCall!==data.active.id){
          soundSources.forEach(function(source){try{source.stop();}catch(error){}});soundSources=[];
          lastCall=data.active.id;
          document.querySelectorAll('video,audio').forEach(function(media){if(media.dataset.callVolume===undefined)media.dataset.callVolume=String(media.volume);media.volume=.1;});

        }
        if(speechGroup!==groupKey&&window.speechSynthesis)window.speechSynthesis.cancel();
        if(audio&&(speechGroup!==groupKey||(speechCalls.length===1)!==(calls.length===1)))prepareSpeech(groupKey);
        speechGroup=groupKey;speechCalls=calls;
        if(lastSoundCall!==groupKey&&chime(groupKey))lastSoundCall=groupKey;
        timer=setTimeout(clearCall,Math.max(0,data.active.endAt-data.serverTime));
      }else clearCall();
    }catch(error){document.getElementById('connectionStatus').textContent='배정 안내 연결 확인 중';clearCall();}
    setTimeout(refresh,1000);
  }
  refresh();
})();
