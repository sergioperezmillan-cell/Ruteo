const H={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
function extractText(d){return (d?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim()}
const GEMINI_MODELS=['gemini-3.6-flash','gemini-3.5-flash','gemini-3.5-flash-lite'];
const QWEN_MODELS=String(process.env.QWEN_MODELS||'qwen3.8-flash,qwen3.7-flash,qwen3.6-flash,qwen3.5-flash').split(',').map(x=>x.trim()).filter(Boolean);
const QWEN_BASE=String(process.env.QWEN_BASE_URL||'https://trial.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions').trim().replace(/\/$/,'');
function extractOpenAIText(d){return String(d?.choices?.[0]?.message?.content||'').trim()}
async function callQwen(payload){
 const key=String(process.env.QWEN_API_KEY||'').trim();
 if(!key)return {ok:false,missing:true,status:0,data:{},attempts:[]};
 const attempts=[];
 let last={ok:false,status:502,data:{},model:QWEN_MODELS[0],provider:'Qwen',attempts};
 for(const model of QWEN_MODELS){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20000);
  const started=Date.now();
  try{
   const r=await fetch(QWEN_BASE,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+key},signal:controller.signal,body:JSON.stringify({
    model,
    messages:[{role:'user',content:payload}],
    temperature:0.1,
    stream:false,
    enable_thinking:false,
    max_completion_tokens:1800,
    response_format:{type:'json_object'}
   })});
   const d=await r.json().catch(()=>({}));
   const ms=Date.now()-started;
   const reason=r.ok?'ok':(d?.error?.message||('HTTP '+r.status));
   attempts.push({provider:'Qwen',model,status:r.status,ms,reason});
   last={ok:r.ok,status:r.status,data:d,model,provider:'Qwen',attempts};
   if(r.ok)return last;
   // Try the next Qwen model for transient errors or model/quota errors.
   if(![400,401,403,404,408,409,429,500,502,503,504].includes(r.status))break;
  }catch(e){
   const ms=Date.now()-started;
   const timeout=e?.name==='AbortError';
   attempts.push({provider:'Qwen',model,status:0,ms,reason:timeout?'timeout':(e?.message||'fetch error')});
   last={ok:false,status:timeout?504:502,data:{},model,provider:'Qwen',attempts};
  }finally{clearTimeout(timer)}
 }
 return last;
}
async function callGemini(key,payload,previousAttempts=[]){
 const attempts=[...previousAttempts];
 let last={status:502,data:{},attempts};
 for(const model of GEMINI_MODELS){
  const url='https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent?key='+encodeURIComponent(key);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20000);
  const started=Date.now();
  try{
   const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},signal:controller.signal,body:JSON.stringify(payload)});
   const d=await r.json().catch(()=>({}));
   const ms=Date.now()-started;
   attempts.push({provider:'Gemini',model,status:r.status,ms,reason:r.ok?'ok':(d?.error?.message||('HTTP '+r.status))});
   last={status:r.status,data:d,model,provider:'Gemini',attempts};
   if(r.ok)return {ok:true,status:r.status,data:d,model,provider:'Gemini',attempts};
   if(r.status!==429) break;
  }catch(e){
   const ms=Date.now()-started;
   attempts.push({provider:'Gemini',model,status:0,ms,reason:e?.name==='AbortError'?'timeout':(e?.message||'fetch error')});
   last={status:504,data:{},model,provider:'Gemini',attempts};
  }finally{clearTimeout(timer)}
 }
 return {ok:false,...last};
}

async function callOverpass(lat,lon,radius){
 const q=`[out:json][timeout:30];(
 nwr(around:${radius},${lat},${lon})[name][tourism];
 nwr(around:${radius},${lat},${lon})[name][historic];
 nwr(around:${radius},${lat},${lon})[name][heritage];
 nwr(around:${radius},${lat},${lon})[name][amenity=place_of_worship];
 nwr(around:${radius},${lat},${lon})[name][amenity~"^(arts_centre|theatre|museum|library|fountain)$"];
 nwr(around:${radius},${lat},${lon})[name][building~"^(church|chapel|cathedral|castle|fort|palace|manor|townhall|monastery|convent|synagogue|mosque)$"];
 nwr(around:${radius},${lat},${lon})[name][leisure~"^(park|garden|nature_reserve|recreation_ground)$"];
 nwr(around:${radius},${lat},${lon})[name][memorial];
 nwr(around:${radius},${lat},${lon})[name][man_made~"^(monument|tower|bridge|watermill|windmill|obelisk)$"];
 nwr(around:${radius},${lat},${lon})[name][place=square];
 nwr(around:${radius},${lat},${lon})[name][natural~"^(peak|hill|rock|cave_entrance|waterfall|spring|wood|scrub)$"];
 nwr(around:${radius},${lat},${lon})[name][waterway~"^(waterfall|weir|dam)$"];
 nwr(around:${radius},${lat},${lon})[name][information~"^(board|guidepost)$"];
 );out center tags;`;
 const endpoints=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
 for(const url of endpoints){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),30000);
  try{
   const r=await fetch(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'data='+encodeURIComponent(q),signal:controller.signal});
   const d=await r.json().catch(()=>null);
   if(!r.ok||!d?.elements) continue;
   const seen=new Set();
   return d.elements.map(e=>{
    const t=e.tags||{}; const lat2=Number(e.lat??e.center?.lat),lon2=Number(e.lon??e.center?.lon);
    const type=String(t.tourism||t.historic||t.heritage||t.amenity||t.building||t.leisure||t.memorial||t.man_made||t.place||t.natural||t.waterway||t.information||'lugar de interés');
    return {
      name:String(t.name||t['name:fr']||t['name:es']||'').trim(),
      name_fr:String(t['name:fr']||'').trim(),
      name_es:String(t['name:es']||'').trim(),
      type, lat:lat2, lon:lon2,
      description:String(t.description||t['description:fr']||t['description:es']||'').trim(),
      website:String(t.website||t['contact:website']||'').trim(),
      osmType:e.type,id:e.id
    };
   }).filter(x=>x.name&&Number.isFinite(x.lat)&&Number.isFinite(x.lon)).filter(x=>{
    const k=x.name.toLowerCase(); if(seen.has(k))return false; seen.add(k); return true;
   });
  }catch(e){}
  finally{clearTimeout(timer)}
 }
 return [];
}
function distanceKm(lat1,lon1,lat2,lon2){const R=6371,rad=x=>x*Math.PI/180,dLat=rad(lat2-lat1),dLon=rad(lon2-lon1),a=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(a))}

function parsePlaces(text){
 text=String(text||'').trim().replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/\s*```$/,'');
 let a;try{a=JSON.parse(text)}catch(e){const i=text.indexOf('{'),j=text.lastIndexOf('}');if(i<0||j<i)throw new Error('La IA no devolvió JSON válido');a=JSON.parse(text.slice(i,j+1))}
 const arr=Array.isArray(a)?a:(Array.isArray(a?.places)?a.places:[]);
 const seen=new Set();
 return arr.map((x,i)=>({name:String(x?.name||'').trim(),type:String(x?.type||'lugar de interés').trim(),description:String(x?.description||'').trim(),score:Number(x?.score)||100-i*5,lat:Number(x?.lat),lon:Number(x?.lon)})).filter(x=>x.name&&!seen.has(x.name.toLowerCase())&&(seen.add(x.name.toLowerCase()),true)).slice(0,15);
}
module.exports=async (req,res)=>{
 if(req.method!=='POST')return res.status(405).json({error:'Usa POST'});
 const b=req.body||{};
 const name=String(b.name||'').trim(), context=String(b.context||name).trim();
 const lat=Number(b.lat),lon=Number(b.lon),prefs=b.preferences||{};
 if(!name)return res.status(400).json({error:'Falta el lugar'});
 const movement=prefs.movement==='driving'?'EN COCHE':(prefs.movement==='bicycling'?'EN BICICLETA':'ANDANDO');
 const complete=prefs.amount==='complete';
 const amount=complete?'VISITA COMPLETA':'SOLO LO IMPRESCINDIBLE';
 const notes=String(prefs.notes||'').trim();
 const radius=complete?20000:8000;

 // 1) PRIMERA BÚSQUEDA: Qwen trabaja por su cuenta, sin una lista cerrada de OSM.
 const firstPrompt=`Eres un experto guía turístico local. Prepara una selección realista para una persona que va a VISITAR ${context}.
CENTRO EXACTO: ${name}, coordenadas ${lat}, ${lon}.
PREFERENCIAS: se moverá ${movement}; quiere ${amount}; petición libre: ${notes||'ninguna'}.
Haz esta primera búsqueda POR TU CUENTA usando tu conocimiento del destino. NO estás limitado por ninguna base de datos externa.
Si el destino tiene monumentos o lugares emblemáticos claramente conocidos, inclúyelos. Para una VISITA COMPLETA busca deliberadamente variedad: monumentos, patrimonio histórico, iglesias, ermitas, catedrales, castillos o fortalezas, arquitectura singular, museos y espacios culturales, plazas y cascos históricos, miradores, puentes, fuentes, jardines, parques, naturaleza y otros lugares con interés turístico real. Para LO IMPRESCINDIBLE devuelve solo los 4-6 mejores.
Prioriza calidad turística real y una distancia razonable del centro. No incluyas restaurantes, hoteles, tiendas, farmacias, parkings ni otros servicios salvo que la petición libre los pida expresamente.
Para cada lugar usa el nombre EXACTO Y ESPECÍFICO que utilizarías para localizarlo en un mapa, incluyendo la localidad cuando ayude. Proporciona también coordenadas aproximadas basadas en tu conocimiento; son una ayuda secundaria y la aplicación las verificará después mediante geocodificación real.
En VISITA COMPLETA busca una primera lista de aproximadamente 6-10 lugares fuertes y variados. Esta NO es todavía la lista final: habrá una segunda revisión con candidatos externos. No rellenes con lugares inventados.
Asigna score 0-100 según interés turístico, no solo proximidad.
JSON EXCLUSIVO:
{"places":[{"name":"nombre exacto","type":"categoría","description":"por qué merece la pena","score":95,"lat":39.856,"lon":-4.024}],"extras":[]}`;

 // 2) FUENTE EXTERNA: OSM descubre candidatos que Qwen podría haberse dejado.
 let osmCandidates=[];
 try{osmCandidates=await callOverpass(lat,lon,radius)}catch(e){osmCandidates=[]}
 osmCandidates.sort((a,b)=>distanceKm(lat,lon,a.lat,a.lon)-distanceKm(lat,lon,b.lat,b.lon));
 osmCandidates=osmCandidates.slice(0,100);
 const osmText=osmCandidates.length?osmCandidates.map((x,i)=>`${i+1}. ${x.name}${x.name_fr&&x.name_fr!==x.name?' | FR: '+x.name_fr:''}${x.name_es&&x.name_es!==x.name?' | ES: '+x.name_es:''} | ${x.type}${x.description?' | descripción: '+x.description:''}${x.website?' | web: '+x.website:''} | coordenadas OSM: ${x.lat}, ${x.lon}`).join('\n'):'(No se pudo obtener la lista OSM. Continúa con tu propio conocimiento.)';

 try{
  let first=await callQwen(firstPrompt);
  let attempts=first.attempts||[];
  let initial=[];
  if(first.ok) initial=parsePlaces(extractOpenAIText(first.data));

  // Si Qwen no responde en la primera fase, usamos Gemini como respaldo para mantener el flujo.
  if(!initial.length){
   const key=String(process.env.GEMINI_API_KEY||'').trim();
   if(key){
    const gg=await callGemini(key,{contents:[{parts:[{text:firstPrompt}]}],generationConfig:{temperature:0.1,responseMimeType:'application/json'}},attempts);
    attempts=gg.attempts||attempts;
    if(gg.ok){
     initial=parsePlaces(extractText(gg.data));
     first={...gg,provider:'Gemini'};
    }
   }
  }
  // Si Qwen/Gemini no encuentran nada, NO abortamos: OSM puede rescatar el destino.
  // En ese caso la segunda llamada de Qwen trabaja sobre los candidatos externos y puede construir la lista.

  // 3) SEGUNDA BÚSQUEDA: Qwen recibe los candidatos externos + su propia lista.
  // No es una whitelist: OSM solo sirve para descubrir posibles lugares adicionales.
  const initialText=initial.length?initial.map((x,i)=>`${i+1}. ${x.name} | ${x.type} | coordenadas aprox. ${Number.isFinite(x.lat)?x.lat:'?'}, ${Number.isFinite(x.lon)?x.lon:'?'}`).join('\n'):'(La primera búsqueda de IA no devolvió lugares utilizables; usa tu conocimiento del destino y los candidatos OSM como apoyo.)';
  const mergePrompt=`Eres el mismo experto guía turístico local. Estamos preparando ${amount} para ${context}.
CENTRO EXACTO: ${name}, coordenadas ${lat}, ${lon}.
PREFERENCIAS: ${movement}; petición libre: ${notes||'ninguna'}.

PRIMERA LISTA: estos lugares los encontraste tú en una primera búsqueda independiente. TIENEN PRIORIDAD. Debes conservar sus nombres, coordenadas aproximadas y puntuación cuando sigan siendo adecuados. No sustituyas un lugar de esta lista por otro equivalente solo por aparecer en OSM.
${initialText}

CANDIDATOS EXTERNOS OSM: esta segunda lista NO es una lista cerrada ni una whitelist. OSM puede estar incompleto, tener nombres distintos o contener lugares poco útiles. Úsala SOLO para detectar lugares reales que quizá falten en tu primera lista.
${osmText}

Ahora haz una SEGUNDA REVISIÓN:
1. Conserva los lugares buenos de la PRIMERA LISTA. Si está vacía, realiza tú mismo la selección a partir de tu conocimiento del destino y de los candidatos OSM.
2. Revisa los candidatos OSM y añade únicamente lugares reales que tengan interés turístico y que no estén ya representados en la primera lista.
3. Si un candidato OSM es el mismo lugar que uno de la primera lista aunque tenga otro nombre, NO lo añadas como duplicado: conserva el de la primera lista.
4. NO omitas un monumento importante, catedral, iglesia, castillo, museo, casco histórico u otro lugar emblemático solo porque no aparezca en OSM. Tu conocimiento sigue siendo válido.
5. No inventes lugares ficticios. OSM es solo una ayuda para descubrir, no una garantía de que todo candidato sea interesante.
6. En VISITA COMPLETA intenta terminar con 12-15 lugares reales y variados. En LO IMPRESCINDIBLE termina con 4-6.
7. Ordena por interés turístico. Score 90-100 imprescindible/muy destacado; 75-89 muy recomendable; 60-74 interesante; 40-59 curiosidad.
8. Usa para cada lugar el nombre EXACTO Y ESPECÍFICO que mejor permita encontrarlo en un mapa, incluyendo localidad cuando ayude. Da coordenadas aproximadas como ayuda secundaria. La aplicación verificará después la ubicación por nombre + localidad con geocodificación real.
9. No incluyas servicios en places salvo petición expresa.

IMPORTANTE: la PRIMERA LISTA tiene prioridad frente a duplicados de OSM.
JSON EXCLUSIVO:
{"places":[{"name":"nombre exacto","type":"categoría","description":"por qué merece la pena","score":95,"lat":39.856,"lon":-4.024}],"extras":[]}`;

  let second=await callQwen(mergePrompt);
  attempts=second.attempts||attempts;
  let finalPlaces=[];
  if(second.ok)finalPlaces=parsePlaces(extractOpenAIText(second.data));

  // Si la segunda fase falla, conservamos la primera: nunca dejamos una buena búsqueda sin resultado.
  if(!finalPlaces.length){
   finalPlaces=initial;
   if(finalPlaces.length) return res.status(200).json({places:finalPlaces,source:first.provider||'Qwen',model:first.model||'',attempts,discovery:'qwen+osm',merge:'first-list-fallback'});
   return res.status(502).json({error:'Ni la búsqueda IA ni la revisión con OSM devolvieron lugares utilizables',attempts,osmCandidates:osmCandidates.length});
  }

  // La segunda fase es un juez, pero la primera lista tiene prioridad: recuperamos cualquier
  // elemento inicial que Qwen haya omitido accidentalmente y evitamos duplicados obvios por nombre.
  const norm=s=>String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  const sameName=(a,b)=>{const x=norm(a),y=norm(b);return x===y||x.includes(y)||y.includes(x)};
  const samePlace=(a,b)=>{if(sameName(a.name,b.name))return true; if(Number.isFinite(a.lat)&&Number.isFinite(a.lon)&&Number.isFinite(b.lat)&&Number.isFinite(b.lon)){return distanceKm(a.lat,a.lon,b.lat,b.lon)<=0.5} return false};
  const merged=[];
  for(const p of initial){
   const hit=finalPlaces.find(q=>samePlace(p,q));
   merged.push(hit?{...hit,name:p.name,type:p.type||hit.type,description:p.description||hit.description,score:p.score,lat:p.lat,lon:p.lon}:p);
  }
  for(const p of finalPlaces){
   if(!merged.some(q=>samePlace(q,p)))merged.push(p);
  }
  finalPlaces=merged.slice(0,15);
  return res.status(200).json({places:finalPlaces,source:second.provider||first.provider||'Qwen',model:second.model||first.model||'',attempts,discovery:'qwen+osm',merge:'first-priority'});
 }catch(e){return res.status(502).json({error:e.message||'No se pudo completar la búsqueda'});}
};
