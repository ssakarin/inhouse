(function () {
  "use strict";
  var stage=document.getElementById('stage'), timer, lastCall='', audio, enabled=true, lastSoundCall='', chimeBuffer, chimeLoading=false, soundSources=[];
  var clockOffset=0;
  var clockFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false});
  function updateClock(){document.getElementById('waitingClock').textContent=clockFormat.format(new Date(Date.now()+clockOffset));}
  updateClock();setInterval(updateClock,1000);
  function unlockAudio(){
    var Audio=window.AudioContext||window.webkitAudioContext;
    if(!Audio)return;
    try{
      audio=audio||new Audio();if(audio.state!=='running')audio.resume().catch(function(){});
      if(!chimeBuffer&&!chimeLoading){
        chimeLoading=true;
        fetch('assets/call-four-tone.wav',{cache:'no-store'}).then(function(response){if(!response.ok)throw Error('chime');return response.arrayBuffer();}).then(function(buffer){
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
  function chime(){
    if(!enabled||!audio||audio.state!=='running'||!chimeBuffer)return false;
    var source=audio.createBufferSource();source.buffer=chimeBuffer;source.connect(audio.destination);
    soundSources.push(source);
    source.onended=function(){source.disconnect();soundSources=soundSources.filter(function(item){return item!==source;});};
    source.start();return true;
  }
  function clearCall(){soundSources.forEach(function(source){try{source.stop();}catch(error){}});soundSources=[];stage.classList.remove('is-calling','is-group-calling');document.getElementById('callingMessage').hidden=true;document.getElementById('groupCalling').hidden=true;document.querySelectorAll('video,audio').forEach(function(media){if(media.dataset.callVolume!==undefined){media.volume=Number(media.dataset.callVolume);delete media.dataset.callVolume;}});}
  async function refresh(){
    try{
      var controller=new AbortController(),timeout=setTimeout(function(){controller.abort();},5000);
      var response;
      try{response=await fetch('/signage/status',{cache:'no-store',signal:controller.signal});}finally{clearTimeout(timeout);}
      if(!response.ok)throw Error('status');var data=await response.json();
      clockOffset=data.serverTime-Date.now();updateClock();
      document.getElementById('waitingCount').textContent=data.waitingCount;
      document.getElementById('consultationWaitingCount').textContent=data.consultationWaitingCount;
      document.getElementById('connectionStatus').textContent='';
      var recent=document.getElementById('recentCalls');recent.replaceChildren();
      (data.recent||[]).filter(function(call){return data.serverTime-call.endAt<60000;}).slice(0,3).forEach(function(call){var row=document.createElement('span');row.textContent=call.maskedName+'님 → '+call.bedLabel;recent.appendChild(row);});
      recent.hidden=!recent.childElementCount;
      clearTimeout(timer);
      if(data.active){
        document.getElementById('callingName').textContent=data.active.maskedName+'님';
        document.getElementById('callingDestination').textContent=data.active.bedLabel;
        var calls=data.activeCalls&&data.activeCalls.length?data.activeCalls:[data.active];
        var isGroup=calls.length>1,groupKey=data.active.groupId||data.active.id;
        document.getElementById('callingMessage').hidden=isGroup;
        document.getElementById('groupCalling').hidden=!isGroup;
        stage.classList.add('is-calling');stage.classList.toggle('is-group-calling',isGroup);
        if(isGroup){
          var list=document.getElementById('groupCallList');list.replaceChildren();
          list.classList.toggle('single-column',calls.length<=5);
          list.style.gridTemplateRows='repeat('+(calls.length<=5?calls.length:Math.ceil(calls.length/2))+', auto)';
          calls.forEach(function(call){
            var row=document.createElement('div'),name=document.createElement('span'),arrow=document.createElement('span'),destination=document.createElement('strong');
            row.className='group-call-row';name.textContent=call.maskedName+'님';arrow.className='group-call-arrow';arrow.textContent='→';destination.textContent=call.bedLabel;
            row.appendChild(name);row.appendChild(arrow);row.appendChild(destination);list.appendChild(row);
          });
        }
        if(lastCall!==data.active.id){
          lastCall=data.active.id;
          document.querySelectorAll('video,audio').forEach(function(media){if(media.dataset.callVolume===undefined)media.dataset.callVolume=String(media.volume);media.volume=.1;});

        }
        if(lastSoundCall!==groupKey&&chime())lastSoundCall=groupKey;
        timer=setTimeout(clearCall,Math.max(0,data.active.endAt-data.serverTime));
      }else clearCall();
    }catch(error){document.getElementById('waitingCount').textContent='—';document.getElementById('consultationWaitingCount').textContent='—';document.getElementById('connectionStatus').textContent='대기 현황 연결 확인 중';clearCall();}
    setTimeout(refresh,1000);
  }
  refresh();
})();
