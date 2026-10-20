const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('index.html','utf8');
const regular=[1,2,3,4,5,6,8,9,10,11,12,13,14];

test('position controls show the requested wording and order, and both bed pickers render multiple selections',()=>{
  const c=vm.createContext({
    REGULAR_BED_NUMBERS:regular, normalizePatientPositions:v=>Array.isArray(v)?v:[v].filter(Boolean),
    PATIENT_POSITIONS:['left_lateral','supine','lateral','sitting','prone','right_lateral'].map(id=>({id,label:id})),
    formBodyPartsByScope:{desk:{bedPreferences:{preferredBeds:[1,3],nonPreferredBeds:[2,4]}}},
    selectedBedNo:5,getBedData:()=>({bodyParts:{bedPreferences:{preferredBeds:[13,14]}}})
  });
  vm.runInContext(source.slice(source.indexOf('  function normalizeBedPreferences'),source.indexOf('  function getPreferredBedOrder')),c);
  vm.runInContext(source.slice(source.indexOf('  function renderPatientPositionChip('),source.indexOf('  async function saveBedPreference(')),c);
  const html=c.renderPatientPositionChip([], 'desk');
  assert.deepEqual([...html.matchAll(/data-position="([^"]+)"[^>]*>([^<]+)<\/button>/g)].map(m=>[m[1],m[2]]),[
    ['left_lateral','왼쪽'],['supine','전면'],['lateral','옆'],['sitting','앉아서'],['prone','후면'],['right_lateral','오른쪽']
  ]);
  assert(!html.includes('낮은베드'));
  assert(html.includes('선호베드 1·3번'));
  assert(html.includes('비선호베드 2·4번'));
  assert.equal((html.match(/data-bed-value="\d+" aria-pressed="true"/g)||[]).length,4);
  assert.equal((html.match(/data-bed-value=/g)||[]).length,regular.length*2);
  const preferredHtml=html.slice(html.indexOf('data-preference-field="preferredBeds"'),html.indexOf('data-preference-field="nonPreferredBeds"'));
  const nonPreferredHtml=html.slice(html.indexOf('data-preference-field="nonPreferredBeds"'));
  const disabledBeds=fragment=>[...fragment.matchAll(/data-bed-value="(\d+)"[^>]*\sdisabled\b/g)].map(m=>Number(m[1]));
  assert.deepEqual(disabledBeds(preferredHtml),[2,4]);
  assert.deepEqual(disabledBeds(nonPreferredHtml),[1,3]);
  assert(preferredHtml.includes('비선호베드에 선택됨'));
  assert(nonPreferredHtml.includes('선호베드에 선택됨'));
  c.formBodyPartsByScope.desk.bedPreferences=c.updateBedPreferences(c.formBodyPartsByScope.desk.bedPreferences,'preferredBeds',[]);
  const afterPreferredClear=c.renderBedPreferenceControls('desk');
  assert.deepEqual(disabledBeds(afterPreferredClear.slice(afterPreferredClear.indexOf('data-preference-field="nonPreferredBeds"'))),[]);
  c.formBodyPartsByScope.desk.bedPreferences=c.updateBedPreferences(c.formBodyPartsByScope.desk.bedPreferences,'nonPreferredBeds',[]);
  assert.deepEqual(disabledBeds(c.renderBedPreferenceControls('desk')),[]);
  const both=html+c.renderBedPreferenceControls('');
  const ids=[...both.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length);
});

function pickerContext(field,blocked=[]){
  const calls=[],events=[],options=[];
  const picker={
    dataset:{preferenceField:field,triggerId:'toggle'},style:{},open:false,
    matches:()=>picker.open,showPopover:()=>{picker.open=true;},hidePopover:()=>{picker.open=false;},
    getBoundingClientRect:()=>({width:260,height:350}),
    querySelectorAll:selector=>selector.includes('[aria-pressed="true"]')?options.filter(o=>o.pressed==='true'):options,
    querySelector:selector=>selector==='[data-bed-preference-cancel]'?{focus:()=>events.push('cancel-focus')}
      :options.find(o=>(!selector.includes('[aria-pressed="true"]')||o.pressed==='true')&&(!selector.includes(':not(:disabled)')||!o.disabled))
  };
  const toggle={dataset:{bedValues:'1'},getAttribute:()=> 'picker',getBoundingClientRect:()=>({left:25,bottom:50}),focus:()=>events.push('toggle-focus')};
  for(const no of regular)options.push({
    dataset:{bedValue:String(no)},pressed:'false',disabled:blocked.includes(no),closest:()=>picker,
    getAttribute(){return this.pressed;},setAttribute(name,value){assert.equal(name,'aria-pressed');this.pressed=String(value);},focus:()=>events.push(`bed-${no}-focus`)
  });
  const c=vm.createContext({window:{innerWidth:1000,innerHeight:1000},
    document:{getElementById:id=>id==='picker'?picker:id==='toggle'?toggle:null},
    saveBedPreference:async(button,savedField,values)=>{assert.equal(button,toggle);calls.push({field:savedField,values:Array.from(values)});}
  });
  vm.runInContext(source.slice(source.indexOf('  window.openBedPreferencePicker ='),source.indexOf('  function renderBodyPartChips(')),c);
  return {api:c.window,picker,toggle,options,calls,events,control:{closest:()=>picker}};
}

for(const field of ['preferredBeds','nonPreferredBeds'])test(`${field}: multiple choices stay open, save together, and canceled drafts do not leak`,async()=>{
  const r=pickerContext(field),option=no=>r.options.find(o=>Number(o.dataset.bedValue)===no);
  r.api.openBedPreferencePicker(r.toggle);
  assert.equal(option(1).pressed,'true');
  r.api.toggleBedPreferenceSelection(option(3));
  r.api.toggleBedPreferenceSelection(option(5));
  assert.equal(r.picker.open,true);
  assert.equal(r.calls.length,0);
  await r.api.applyBedPreferenceSelection(r.control);
  assert.deepEqual(r.calls,[{field,values:[1,3,5]}]);
  assert.equal(r.picker.open,false);
  assert(r.events.includes('toggle-focus'));
  r.api.openBedPreferencePicker(r.toggle);
  r.api.toggleBedPreferenceSelection(option(4));
  r.api.cancelBedPreferenceSelection(r.control);
  r.api.openBedPreferencePicker(r.toggle);
  assert.equal(option(4).pressed,'false');
  assert.equal(r.calls.length,1);
  r.api.clearBedPreferenceSelection(r.control);
  assert.equal(r.picker.open,true);
  assert.equal(r.options.filter(o=>o.pressed==='true').length,0);
  await r.api.applyBedPreferenceSelection(r.control);
  assert.deepEqual(r.calls[1],{field,values:[]});
});

for(const field of ['preferredBeds','nonPreferredBeds'])test(`${field}: opposite choices cannot be toggled or submitted`,async()=>{
  const r=pickerContext(field,[1,3]),option=no=>r.options.find(o=>Number(o.dataset.bedValue)===no);
  r.api.openBedPreferencePicker(r.toggle);
  assert.equal(option(1).pressed,'false');
  assert(r.events.includes('bed-2-focus'));
  r.api.toggleBedPreferenceSelection(option(3));
  assert.equal(option(3).pressed,'false');
  r.api.toggleBedPreferenceSelection(option(2));
  // A stale selected state must also be filtered out when applying.
  option(3).pressed='true';
  await r.api.applyBedPreferenceSelection(r.control);
  assert.deepEqual(r.calls,[{field,values:[2]}]);
});

test('a picker with every bed selected in the opposite list focuses cancel',()=>{
  const r=pickerContext('nonPreferredBeds',regular);
  r.api.openBedPreferencePicker(r.toggle);
  assert(r.events.includes('cancel-focus'));
  assert(r.options.every(option=>option.disabled&&option.pressed==='false'));
});
