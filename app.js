const $=s=>document.querySelector(s);
const STATE_KEY='ruteoStateV33';
let pois=[], selected=new Set(), mode='driving', optimized=[], chosenPlace=null, suggestTimer=null, visitMode='walking', visitAmount='essential', aiProvider='', aiModel='';
let currentStep=1;

function saveState(){
 try{
  const state={
   version:33,currentStep,pois,selected:[...selected],mode,visitMode,visitAmount,
   chosenPlace,plannerMode,chatHistory,chatPlaces,
   place:$('#place')?.value||'',visitNotes:$('#visitNotes')?.value||'',
   customStart:$('#customStart')?.value||'',start:$('input[name=start]:checked')?.value||'first',
   returnToStart:!!$('#returnToStart')?.checked,
   optimizedItems:Array.isArray(optimized)?optimized:[],
   optimizedMeta:Array.isArray(optimized)?{startType:optimized.startType||'first',startPoint:optimized.startPoint||null,returnToStart:!!optimized.returnToStart}:null,
   aiProvider,aiModel,
   routeList:$('#routeList')?.innerHTML||'',routeActionsVisible:!$('#routeActions')?.classList.contains('hidden')
  };
  localStorage.setItem(STATE_KEY,JSON.stringify(state));
 }catch(e){console.warn('No se pudo guardar el estado',e)}
}
function clearState(){try{localStorage.removeItem(STATE_KEY)}catch(e){}}
function restoreState(){
 try{
  const raw=localStorage.getItem(STATE_KEY); if(!raw)return false;
  const st=JSON.parse(raw); if(!st||st.version!==33)return false;
  pois=Array.isArray(st.pois)?st.pois:[]; selected=new Set(Array.isArray(st.selected)?st.selected:[]);
  mode=st.mode||'driving'; visitMode=st.visitMode||'walking'; visitAmount=st.visitAmount||'essential'; aiProvider=st.aiProvider||''; aiModel=st.aiModel||'';
  chosenPlace=st.chosenPlace||null; plannerMode=st.plannerMode||'auto'; chatHistory=Array.isArray(st.chatHistory)?st.chatHistory:[]; chatPlaces=Array.isArray(st.chatPlaces)?st.chatPlaces:[];
  optimized=Array.isArray(st.optimizedItems)?st.optimizedItems:[];
  if(st.optimizedMeta){optimized.startType=st.optimizedMeta.startType||'first';optimized.startPoint=st.optimizedMeta.startPoint||null;optimized.returnToStart=!!st.optimizedMeta.returnToStart;}
  if($('#place'))$('#place').value=st.place||chosenPlace?.display_name||'';
  if($('#visitNotes'))$('#visitNotes').value=st.visitNotes||'';
  if($('#customStart'))$('#customStart').value=st.customStart||'';
  const sr=$(`input[name=start][value="${st.start||'first'}"]`); if(sr)sr.checked=true;
  $('#customStart')?.classList.toggle('hidden',(st.start||'first')!=='custom');
  if($('#returnToStart'))$('#returnToStart').checked=!!st.returnToStart;
  document.querySelectorAll('#visitMode .chip').forEach(b=>b.classList.toggle('active',b.dataset.visitmode===visitMode));
  document.querySelectorAll('#visitAmount .chip').forEach(b=>b.classList.toggle('active',b.dataset.amount===visitAmount));
  document.querySelectorAll('#modes .chip').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
  setPlanner(plannerMode);
  const cm=$('#chatMessages');
  if(cm){cm.innerHTML='<div class="chatMsg ai">👋 Ya sé cuál es tu destino base. Dime qué lugares quieres visitar o qué tipo de sitios buscas. Puedes hablarme con normalidad.</div>'; for(const h of chatHistory){addChat(h.role==='user'?'user':'ai',h.text||'');}}
  if(chatPlaces.length)$('#useChatPlaces')?.classList.remove('hidden');
  if(pois.length){render(); if(st.routeList)$('#routeList').innerHTML=st.routeList; $('#routeActions')?.classList.toggle('hidden',!st.routeActionsVisible);}
  currentStep=Number(st.currentStep)||1; showStep(currentStep);
  return true;
 }catch(e){console.warn('No se pudo restaurar el estado',e);clearState();return false;}
}

function status(t){const el=$('#status'); if(el) el.textContent=t}
function setAI(provider,model){aiProvider=provider||'';aiModel=model||'';const el=$('#aiEngine'); if(el) el.textContent=aiProvider&&aiModel?`IA: ${aiProvider} · ${aiModel}`:'IA: —';saveState();}
function showStep(n){currentStep=n;for(let i=1;i<=4;i++){const el=$('#step'+i);if(el)el.classList.toggle('hidden',i!==n)}document.querySelectorAll('.progressStep').forEach(x=>x.classList.toggle('active',+x.dataset.step===n));window.scrollTo({top:0,behavior:'smooth'});saveState();}
function updateKeyUI(){}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

async function fetchJson(url, options={}){
  const r=await fetch(url,{...options,headers:{Accept:'application/json',...(options.headers||{})}});
  if(!r.ok) throw new Error('HTTP '+r.status);
  return await r.json();
}


function normalizeNominatim(x){
 return {lat:+x.lat,lon:+x.lon,display_name:x.display_name||x.name||''};
}
function normalizePhoton(f){
 const p=f.properties||{}, c=f.geometry?.coordinates||[];
 return {lat:+c[1],lon:+c[0],display_name:[p.name,p.city||p.town||p.village||p.county||p.state,p.country].filter(Boolean).join(', ')};
}

// Nombre corto para las búsquedas internas (p. ej. 'Sare' desde 'Sare, Bayona, Pyrénées...').
function shortPlaceName(name){
 return String(name||'').split(',')[0].trim() || String(name||'').trim();
}

async function nominatimSearch(q,limit=6){
 const url='https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit='+limit+'&accept-language=es&q='+encodeURIComponent(q);
 const d=await fetchJson(url);
 return (d||[]).map(normalizeNominatim).filter(x=>Number.isFinite(x.lat)&&Number.isFinite(x.lon)&&x.display_name);
}
async function photonSearch(q,limit=6){
 const d=await fetchJson('https://photon.komoot.io/api/?limit='+limit+'&lang=es&q='+encodeURIComponent(q));
 return (d.features||[]).map(normalizePhoton).filter(x=>Number.isFinite(x.lat)&&Number.isFinite(x.lon)&&x.display_name);
}

async function geocode(q){
 try{
   const results=await Promise.any([nominatimSearch(q,1),photonSearch(q,1)]);
   if(results.length)return results[0];
 }catch(e){}
 throw new Error('No puedo localizar ese lugar. Prueba escribiendo también la provincia o el país.');
}

async function autocomplete(q){
 const box=$('#suggestions');
 if(q.trim().length<2){box.classList.add('hidden');box.innerHTML='';return}
 const stamp=q;
 try{
   // Primero Nominatim, con Photon como respaldo. Así no dependemos de un único servicio.
   const results=await Promise.any([nominatimSearch(q,6),photonSearch(q,6)]);
   if($('#place').value!==stamp)return;
   if(!results.length){box.classList.add('hidden');return}
   const unique=[], seen=new Set();
   results.forEach(x=>{const k=x.display_name.toLowerCase();if(!seen.has(k)){seen.add(k);unique.push(x)}});
   box.innerHTML=unique.slice(0,6).map((p,i)=>`<button type="button" class="suggestion" data-i="${i}"><b>${esc(p.display_name.split(',')[0])}</b><span>${esc(p.display_name.split(',').slice(1).join(',').trim())}</span></button>`).join('');
   box.classList.remove('hidden');
   box.querySelectorAll('.suggestion').forEach(b=>b.onclick=()=>{
     const p=unique[+b.dataset.i]; chosenPlace=p; $('#place').value=p.display_name; box.classList.add('hidden');
   });
 }catch(e){
   if($('#place').value===stamp){box.classList.add('hidden');}
 }
}

// Descubrimiento v11: el navegador ya no consulta directamente bases externas de POIs.
// La consulta se hace en una Netlify Function del mismo sitio, evitando bloqueos CORS.
async function discoverPlaces(lat,lon,placeName,contextName,preferences={}){const r=await fetch('/api/discover',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lat,lon,name:placeName,context:contextName||placeName,preferences})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));if(!Array.isArray(d.places)||!d.places.length)throw new Error(d.error||'La IA no ha devuelto lugares para ese sitio.');return d;}
// Nunca usamos las coordenadas devueltas por la IA como fuente de navegación.
// La IA decide QUÉ visitar; Nominatim/Photon verifican DÓNDE está cada lugar.
async function geoCandidates(q,limit=8){
 const settled=await Promise.allSettled([nominatimSearch(q,limit),photonSearch(q,limit)]);
 const all=[];
 for(const r of settled) if(r.status==='fulfilled') all.push(...r.value);
 const seen=new Set();
 return all.filter(x=>{const k=`${x.lat.toFixed(5)},${x.lon.toFixed(5)}`;if(seen.has(k))return false;seen.add(k);return true;});
}
function maxDistanceForMovement(m){
 if(m==='walking') return 30;
 if(m==='bicycling') return 80;
 return 200;
}
// La IA propone el nombre. Nosotros buscamos VARIAS coincidencias y elegimos la más cercana
// al destino base, siempre dentro de un radio de seguridad según el medio de transporte.
async function geocodeCandidate(p,placeName,origin,maxKm){
 const short=shortPlaceName(placeName);
 const queries=[`${p.name}, ${placeName}`,`${p.name}, ${short}`,p.name];
 let candidates=[];
 for(const q of queries){
  try{
   const found=await geoCandidates(q,8);
   candidates.push(...found.map(g=>({...g,query:q})));
   const valid=found.map(g=>({...g,km:distance(origin,{lat:+g.lat,lon:+g.lon})}))
    .filter(g=>Number.isFinite(g.km)&&g.km<=maxKm)
    .sort((a,b)=>a.km-b.km);
   // Si la búsqueda contextual ya devuelve candidatos válidos, no hace falta abrir más la búsqueda.
   if(valid.length){const g=valid[0];return {...p,lat:+g.lat,lon:+g.lon,verified:true,km:g.km};}
  }catch(e){}
 }
 // Última oportunidad: entre TODAS las coincidencias obtenidas, gana siempre la más cercana.
 const seen=new Set();
 const valid=candidates.filter(g=>{const k=`${g.lat.toFixed(5)},${g.lon.toFixed(5)}`;if(seen.has(k))return false;seen.add(k);return true;})
  .map(g=>({...g,km:distance(origin,{lat:+g.lat,lon:+g.lon})}))
  .filter(g=>Number.isFinite(g.km)&&g.km<=maxKm)
  .sort((a,b)=>a.km-b.km);
 if(valid.length){const g=valid[0];return {...p,lat:+g.lat,lon:+g.lon,verified:true,km:g.km};}
 return null;
}

$('#place').addEventListener('input',e=>{
 if(currentStep===1)clearState();
 chosenPlace=null; clearTimeout(suggestTimer);
 suggestTimer=setTimeout(()=>autocomplete(e.target.value),350);
});
$('#place').addEventListener('keydown',e=>{if(e.key==='Enter')$('#discover').click()});
document.addEventListener('click',e=>{if(!e.target.closest('.searchWrap'))$('#suggestions').classList.add('hidden')});

function distance(a,b){const R=6371,rad=x=>x*Math.PI/180,dLat=rad(b.lat-a.lat),dLon=rad(b.lon-a.lon),x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(x))}

function render(){
 $('#results').innerHTML=pois.map((p,i)=>`<label class="card ${selected.has(i)?'selected':''}"><input class="check" type="checkbox" data-i="${i}" ${selected.has(i)?'checked':''}><div><div class="cardTitle">${esc(p.name)}</div><div class="meta">${esc(p.type)} · 📍 ${p.km.toFixed(1)} km del centro</div></div></label>`).join('');
 $('#continue').disabled=!selected.size;
 document.querySelectorAll('.check').forEach(c=>c.onchange=e=>{const i=+e.target.dataset.i;e.target.checked?selected.add(i):selected.delete(i);render()});
}

document.querySelectorAll('#visitMode .chip').forEach(b=>b.onclick=()=>{document.querySelectorAll('#visitMode .chip').forEach(x=>x.classList.remove('active'));b.classList.add('active');visitMode=b.dataset.visitmode;saveState()});
document.querySelectorAll('#visitAmount .chip').forEach(b=>b.onclick=()=>{document.querySelectorAll('#visitAmount .chip').forEach(x=>x.classList.remove('active'));b.classList.add('active');visitAmount=b.dataset.amount;saveState()});

$('#nextToPrefs').onclick=async()=>{
 const q=$('#place').value.trim(); if(!q){alert('⚠️ Escribe un pueblo o ciudad');return}
 try{const g=chosenPlace||await geocode(q);chosenPlace=g; chatHistory=[]; chatPlaces=[]; const cm=$('#chatMessages'); if(cm)cm.innerHTML='<div class="chatMsg ai">👋 Ya sé cuál es tu destino base. Dime qué lugares quieres visitar o qué tipo de sitios buscas. Puedes hablarme con normalidad.</div>'; $('#useChatPlaces')?.classList.add('hidden'); $('#place').value=g.display_name; $('#selectedDestination').textContent='📍 '+(g.display_name||q); showStep(2)}catch(e){alert('⚠️ '+(e.message||'No puedo localizar ese lugar'))}
};
$('#backToPlace').onclick=()=>{clearState();pois=[];selected.clear();optimized=[];chosenPlace=null;$('#place').value='';$('#routeList').innerHTML='';$('#routeActions').classList.add('hidden');showStep(1)};
$('#discover').onclick=async()=>{
 const q=$('#place').value.trim(); if(!q){status('⚠️ Escribe un pueblo o ciudad');return}
 const btn=$('#discover'); btn.disabled=true; $('#suggestions').classList.add('hidden');
 try{
   status('📍 Localizando '+q+'…');
   const g=chosenPlace||await geocode(q);
   status('🔎 Buscando lugares de interés reales…');
   const placeContext=shortPlaceName(g.display_name||q); const fullContext=g.display_name||q;
   status('🤖 Qwen está buscando qué merece la pena ver en '+placeContext+'…');
   const qwenWatch=setTimeout(()=>status('⏳ Qwen sigue trabajando… si no responde, Ruteo pasará automáticamente a Gemini.'),12000);
   const preferences={movement:visitMode,amount:visitAmount,notes:$('#visitNotes').value.trim()};
   const ai=await discoverPlaces(g.lat,g.lon,placeContext,fullContext,preferences);
   clearTimeout(qwenWatch);
   setAI(ai.source,ai.model);
   const raw=ai.places;
   status('📍 Localizando los sitios recomendados…');
   const located=[];
   const maxKm=maxDistanceForMovement(visitMode);
   // Verificamos TODOS los puntos, incluso si Gemini ha dado coordenadas.
   // Así un cambio de modelo no puede desplazar la ruta por coordenadas inventadas.
   for(const p of raw.slice(0,12)){
   const x=await geocodeCandidate(p,g.display_name||q,{lat:+g.lat,lon:+g.lon},maxKm);
     if(x) located.push(x);
   }
   const seen=new Set();
   let ranked=located.filter(p=>{let k=p.name.toLowerCase().trim();if(seen.has(k))return false;seen.add(k);return true})
    .map(p=>({...p,km:distance({lat:+g.lat,lon:+g.lon},p)}))
    .sort((a,b)=>(b.score-a.score)||(a.km-b.km));
   // Seguridad final: jamás aceptamos un POI fuera del radio máximo del medio elegido.
   ranked=ranked.filter(p=>p.km<=maxKm);
   pois=ranked.slice(0,12);
   if(!pois.length) throw new Error('No he encontrado suficientes lugares de interés cerca de ahí. Prueba con otra sugerencia.');
   selected.clear(); pois.slice(0,Math.min(6,pois.length)).forEach((_,i)=>selected.add(i));
   $('#resultsTitle').textContent='Qué ver en '+(g.display_name.split(',')[0]||q);
   $('#resultsMode').textContent=visitAmount==='complete'?'Visita completa · puedes desmarcar los que no quieras':'Selección imprescindible · puedes desmarcar los que no quieras';
   $('#selectTop').textContent=visitAmount==='complete'?'⭐ Seleccionar imprescindibles':'⭐ Imprescindibles';
   render(); showStep(3); saveState();
   status('✨ He encontrado '+pois.length+' lugares reales cerca de '+(g.display_name.split(',')[0]||q)+'.');
 }catch(e){console.error(e);status('⚠️ '+(e.message||'Error de conexión. Inténtalo de nuevo.'))}
 finally{btn.disabled=false}
};

$('#selectTop').onclick=()=>{selected.clear();const n=plannerMode==='manual'?pois.length:Math.min(6,pois.length);pois.slice(0,n).forEach((_,i)=>selected.add(i));render();saveState()};
$('#continue').onclick=()=>{
 // Hereda el desplazamiento elegido en la búsqueda automática.
 // Así no obligamos al usuario a elegirlo dos veces ni volvemos siempre a coche.
 mode = visitMode || mode;
 document.querySelectorAll('#modes .chip').forEach(b=>b.classList.toggle('active', b.dataset.mode===mode));
 showStep(4); saveState();
};
$('#backToPrefs').onclick=()=>showStep(2);
document.querySelectorAll('#modes .chip').forEach(b=>b.onclick=()=>{document.querySelectorAll('#modes .chip').forEach(x=>x.classList.remove('active'));b.classList.add('active');mode=b.dataset.mode;saveState()});
document.querySelectorAll('input[name=start]').forEach(r=>r.onchange=()=>{$('#customStart').classList.toggle('hidden',$('input[name=start]:checked').value!=='custom');saveState()});
$('#optimize').onclick=async()=>{
 let route=[...selected].map(i=>pois[i]), start=$('input[name=start]:checked').value;
 const returnToStart=$('#returnToStart').checked;
 if(start==='current'){if(!navigator.geolocation){alert('Tu navegador no permite ubicación');return}try{const pos=await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:8000}));let cur={lat:pos.coords.latitude,lon:pos.coords.longitude,name:'Mi ubicación'};optimized=nearest(route,cur);optimized.startType='current';optimized.startPoint=cur}catch(e){alert('No se pudo obtener tu ubicación');return}}
 else if(start==='custom'){const q=$('#customStart').value.trim();if(!q){alert('Escribe el punto de inicio');return}try{const g=await geocode(q);let cur={lat:+g.lat,lon:+g.lon,name:g.display_name.split(',')[0]};optimized=nearest(route,cur);optimized.startType='custom';optimized.startPoint=cur}catch(e){alert('No encuentro ese punto');return}}
 else{optimized=nearest(route,route[0]);optimized.startType='first';optimized.startPoint={lat:optimized[0].lat,lon:optimized[0].lon,name:optimized[0].name}}
 optimized.returnToStart=returnToStart;
 const returnItem=returnToStart?`<div class="routeItem routeReturn"><div class="num">↩</div><div><b>Volver al punto de inicio</b><div class="meta">${esc(optimized.startPoint.name)}</div></div></div>`:'';
 const startKind=optimized.startType||start;
 const originRow=(startKind==='first')?'':`<div class="routeItem"><div class="num">0</div><div><b>${esc(optimized.startPoint?.name||'Punto de inicio')}</b><div class="meta">Punto de inicio · sin letra en Maps</div></div></div>`;
 const routeRows=optimized.map((p,i)=>{const n=startKind==='first'?i:i+1;const letter=startKind==='first'?(i===0?'':String.fromCharCode(65+i-1)):String.fromCharCode(65+i);return `<div class="routeItem"><div class="num">${n}</div><div><b>${esc(p.name)}</b><div class="meta">${esc(p.type)}${letter?` · Maps: ${letter}`:' · Punto de inicio'}</div></div></div>`}).join('');
 $('#routeList').innerHTML='<h3>Tu recorrido'+(returnToStart?' · circular':'')+'</h3><div class="mapsLegend">🗺️ <b>Equivalencia Google Maps:</b> punto 0 = origen · 1 = A · 2 = B · 3 = C…</div>'+originRow+routeRows+returnItem; $('#routeActions').classList.remove('hidden');window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'});saveState();
};
function nearest(items,start){let left=[...items],out=[],cur=start;while(left.length){left.sort((a,b)=>distance(cur,a)-distance(cur,b));cur=left.shift();out.push(cur)}return out}
// Enviamos nombre + coordenadas: intentamos conservar la etiqueta legible sin perder la posición verificada.
$('#maps').onclick=()=>{if(!optimized.length)return;const mapPoint=p=>`${p.lat},${p.lon}`, pts=optimized.map(mapPoint), start=$('input[name=start]:checked').value, circular=!!optimized.returnToStart;let origin,destination,wp;if(start==='current'){origin='My Location';destination=circular?'My Location':pts[pts.length-1];wp=circular?pts:pts.slice(0,-1)}else if(start==='custom'){origin=`${optimized.startPoint?.name} (${optimized.startPoint?.lat},${optimized.startPoint?.lon})`;destination=circular?origin:pts[pts.length-1];wp=circular?pts:pts.slice(0,-1)}else{origin=pts[0];destination=circular?origin:pts[pts.length-1];wp=circular?pts.slice(1):pts.slice(1,-1)}let url='https://www.google.com/maps/dir/?api=1&travelmode='+mode+'&origin='+encodeURIComponent(origin)+'&destination='+encodeURIComponent(destination);if(wp.length)url+='&waypoints='+encodeURIComponent(wp.join('|'));window.open(url,'_blank')};
$('#back').onclick=()=>showStep(3);
setAI(aiProvider,aiModel);
updateKeyUI();
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js');

// v22: selector Auto / Manual y conversación con IA
let plannerMode='auto', chatHistory=[], chatPlaces=[];
function addChat(role,text){const d=document.createElement('div');d.className='chatMsg '+(role==='user'?'user':'ai');d.textContent=(role==='user'?'👤 ':'🤖 ')+text;$('#chatMessages').appendChild(d);$('#chatMessages').scrollTop=$('#chatMessages').scrollHeight}
function setPlanner(m){plannerMode=m;document.querySelectorAll('.plannerCard').forEach(x=>x.classList.toggle('active',x.dataset.planner===m));$('#autoPanel').classList.toggle('hidden',m!=='auto');$('#manualPanel').classList.toggle('hidden',m!=='manual');status('');saveState()}
document.querySelectorAll('.plannerCard').forEach(b=>b.onclick=()=>setPlanner(b.dataset.planner));
async function sendChat(){
 const text=$('#chatText').value.trim(); if(!text||!chosenPlace)return;
 const btn=$('#sendChat'); btn.disabled=true; $('#chatText').value=''; addChat('user',text);
 try{
  status('🧠 La IA está preparando tu lista…');
  const r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({destination:chosenPlace.display_name||$('#place').value,lat:+chosenPlace.lat,lon:+chosenPlace.lon,history:chatHistory,message:text})});
  const d=await r.json().catch(()=>({})); if(!r.ok)throw new Error(d.error||('HTTP '+r.status));
  setAI(d.source,d.model);
  addChat('ai',d.reply||'He actualizado la propuesta.');
  chatHistory.push({role:'user',text},{role:'assistant',text:d.reply||''});
  chatPlaces=Array.isArray(d.places)?d.places:[]; saveState();
  if(!chatPlaces.length){status('Sigue concretando qué quieres visitar.');return;}

  // El manual usa EXACTAMENTE la misma verificación y la misma pantalla de resultados que el automático.
  status('📍 Verificando en el mapa la ubicación real de cada lugar…');
  const g=chosenPlace, seen=new Set(), verified=[], maxKm=maxDistanceForMovement(visitMode);
  for(const p of chatPlaces){
   const key=String(p.name||'').toLowerCase().trim(); if(!key||seen.has(key))continue; seen.add(key);
   const x=await geocodeCandidate(p,g.display_name||$('#place').value,{lat:+g.lat,lon:+g.lon},maxKm);
   if(x)verified.push(x);
  }
  pois=verified.map(p=>({...p,km:distance({lat:+g.lat,lon:+g.lon},{lat:+p.lat,lon:+p.lon})}));
  if(!pois.length)throw new Error('No he podido verificar en el mapa los lugares propuestos.');
  selected.clear(); pois.forEach((_,i)=>selected.add(i));
  $('#resultsTitle').textContent='Tu selección para '+(g.display_name.split(',')[0]||$('#place').value);
  $('#resultsMode').textContent='Selección manual · puedes desmarcar los que no quieras';
  $('#selectTop').textContent='⭐ Seleccionar todos';
  render(); showStep(3); status('✨ He encontrado '+pois.length+' lugares reales. Puedes desmarcar los que no quieras.'); saveState();
 }catch(e){addChat('ai','⚠️ '+(e.message||'No he podido completar la búsqueda.'));status('⚠️ '+(e.message||'No se pudieron verificar los lugares.'))}
 finally{btn.disabled=false}
}
$('#sendChat').onclick=sendChat;
$('#chatText').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat()}});
// Restauración persistente: si Android mata el proceso mientras Google Maps está abierto,
// al volver Ruteo reconstruye la pantalla y la ruta desde localStorage.
window.addEventListener('beforeunload',saveState);
window.addEventListener('pagehide',saveState);
restoreState();
