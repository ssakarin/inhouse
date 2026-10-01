(function () {
  "use strict";
  var stage=document.getElementById('stage'), timer, lastCall='', audio, enabled=true, lastSoundCall='', chimeBuffer, chimeLoading=false, soundSources=[], speechGroup='', speechCalls=[];
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
  function announce(group){
    if(group!==speechGroup||!window.speechSynthesis||!window.SpeechSynthesisUtterance)return;
    var numbers=['','일','이','삼','사','오','육','칠','팔','구','십','십일','십이','십삼','십사','십오'];
    var text='화면의 성함과 배정 위치를 확인하시고 이동해 주세요.';
    if(speechCalls.length===1){
      var call=speechCalls[0],no=Number(call.bedNo);
      var destination=no>=101?(numbers[no-100]+' 번 원장실'):no===15?'스파인':numbers[no]+' 번 베드';
      text=(call.speechName||call.maskedName.replace(/＊/g,''))+'님, '+destination+'로 들어와 주세요.';
    }
    var utterance=new window.SpeechSynthesisUtterance(text);
    utterance.lang='ko-KR';utterance.rate=.85;utterance.pitch=1.04;
    var voices=window.speechSynthesis.getVoices().filter(function(voice){return /^ko(?:-|_)?/i.test(voice.lang);});
    var voice=voices.find(function(item){return /natural|neural|online/i.test(item.name);})||voices.find(function(item){return item.default;})||voices[0];
    if(voice)utterance.voice=voice;
    window.speechSynthesis.cancel();window.speechSynthesis.speak(utterance);
  }
  function chime(group){
    if(!enabled||!audio||audio.state!=='running'||!chimeBuffer)return false;
    var source=audio.createBufferSource();source.buffer=chimeBuffer;source.connect(audio.destination);
    soundSources.push(source);
    source.onended=function(){source.disconnect();soundSources=soundSources.filter(function(item){return item!==source;});announce(group);};
    source.start();return true;
  }
  function clearCall(){var wasCalling=stage.classList.contains('is-calling');speechGroup='';speechCalls=[];if(window.speechSynthesis)window.speechSynthesis.cancel();soundSources.forEach(function(source){try{source.stop();}catch(error){}});soundSources=[];stage.classList.remove('is-calling','is-group-calling');document.getElementById('callingMessage').hidden=true;document.getElementById('groupCalling').hidden=true;if(wasCalling&&window.restoreSignageAdvertising)window.restoreSignageAdvertising();document.querySelectorAll('video,audio').forEach(function(media){if(media.dataset.callVolume!==undefined){media.volume=Number(media.dataset.callVolume);delete media.dataset.callVolume;}});}
  async function refresh(){
    try{
      var controller=new AbortController(),timeout=setTimeout(function(){controller.abort();},5000);
      var response;
      try{response=await fetch('/signage/status',{cache:'no-store',signal:controller.signal});}finally{clearTimeout(timeout);}
      if(!response.ok)throw Error('status');var data=await response.json();
      var previousLayout=stage.classList.contains('has-recent');
      document.getElementById('connectionStatus').textContent='';
      var recent=document.getElementById('recentCalls');recent.replaceChildren();
      (data.recent||[]).filter(function(call){return data.serverTime-call.endAt<60000;}).slice(0,3).forEach(function(call){
        var row=document.createElement('span'),name=document.createElement('span'),destination=document.createElement('strong');
        row.className='recent-call-item';name.textContent=call.maskedName+'님';destination.textContent=call.bedLabel;
        row.appendChild(name);row.appendChild(destination);recent.appendChild(row);
      });
      recent.hidden=!recent.childElementCount;
      stage.classList.toggle('has-recent',!recent.hidden);
      var layout=!recent.hidden;
      if(layout!==previousLayout&&!data.active&&!stage.classList.contains('is-calling')&&window.restoreSignageAdvertising)window.restoreSignageAdvertising();
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
            var row=document.createElement('div'),name=document.createElement('span'),destination=document.createElement('strong');
            row.className='group-call-row';name.textContent=call.maskedName+'님';destination.textContent=call.bedLabel;
            row.appendChild(name);row.appendChild(destination);list.appendChild(row);
          });
        }
        if(lastCall!==data.active.id){
          lastCall=data.active.id;
          document.querySelectorAll('video,audio').forEach(function(media){if(media.dataset.callVolume===undefined)media.dataset.callVolume=String(media.volume);media.volume=.1;});

        }
        if(speechGroup!==groupKey&&window.speechSynthesis)window.speechSynthesis.cancel();
        speechGroup=groupKey;speechCalls=calls;
        if(lastSoundCall!==groupKey&&chime(groupKey))lastSoundCall=groupKey;
        timer=setTimeout(clearCall,Math.max(0,data.active.endAt-data.serverTime));
      }else clearCall();
    }catch(error){document.getElementById('connectionStatus').textContent='배정 안내 연결 확인 중';clearCall();}
    setTimeout(refresh,1000);
  }
  refresh();
})();
