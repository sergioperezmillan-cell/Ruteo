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
 const q=`[out:json][timeout:25];(
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
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),28000);
  try{
   const r=await fetch(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'data='+encodeURIComponent(q),signal:controller.signal});
   const d=await r.json().catch(()=>null);
   if(!r.ok||!d?.elements) continue;
   const seen=new Set();
   return d.elements.map(e=>{
    const t=e.tags||{}; const lat2=Number(e.lat??e.center?.lat),lon2=Number(e.lon??e.center?.lon);
    const type=String(t.tourism||t.historic||t.heritage||t.amenity||t.building||t.leisure||t.memorial||t.man_made||t.place||t.natural||t.waterway||t.information||'lugar de interés');
    return {name:String(t.name||'').trim(),type,lat:lat2,lon:lon2,osmType:e.type,id:e.id};
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
 const amount=prefs.amount==='complete'?'VISITA COMPLETA (búsqueda amplia de candidatos reales; el usuario elegirá cuáles visitar)':'SOLO LO IMPRESCINDIBLE (selección corta y muy buena)';
 const notes=String(prefs.notes||'').trim();
 const radius=prefs.amount==='complete'?15000:7000;
 let osmCandidates=[];
 try{osmCandidates=await callOverpass(lat,lon,radius)}catch(e){osmCandidates=[]}
 osmCandidates.sort((a,b)=>distanceKm(lat,lon,a.lat,a.lon)-distanceKm(lat,lon,b.lat,b.lon));
 osmCandidates=osmCandidates.slice(0,100);
 const osmText=osmCandidates.length?osmCandidates.map((x,i)=>`${i+1}. ${x.name} | ${x.type} | ${x.lat.toFixed(6)},${x.lon.toFixed(6)}`).join('\n'):'(No se pudo obtener la lista OSM; usa tu conocimiento como respaldo, pero no inventes lugares.)';
 const prompt=`Eres un experto guía turístico local. Debes preparar una selección para una persona que va a VISITAR ${context}.
CENTRO EXACTO: ${name}, coordenadas ${lat}, ${lon}.
PREFERENCIAS: se moverá ${movement}; quiere ${amount}; petición libre: ${notes||'ninguna'}.
A continuación tienes CANDIDATOS REALES EXTRAÍDOS DE OPENSTREETMAP cerca del centro. Son la fuente principal para descubrir lugares que quizá no conozcas de memoria:
${osmText}
Tu trabajo es valorar esos candidatos y devolver los mejores. Puedes descartar candidatos que sean claramente irrelevantes para un visitante, pero NO descartes automáticamente lugares menos famosos: si tienen interés histórico, cultural, arquitectónico, religioso, paisajístico o turístico razonable, consérvalos como opcionales. No inventes candidatos que no estén en la lista OSM salvo que sea imprescindible y estés muy seguro de que existen.
Prioriza calidad turística real. NO incluyas restaurantes, hoteles, tiendas, farmacias, parkings u otros servicios en places aunque aparezcan en los candidatos. EXCEPCIÓN: si la petición libre solicita expresamente un restaurante, comida, café, aparcamiento u otro servicio, indícalo en la respuesta aparte en "extras", no dentro de places.
En VISITA COMPLETA busca deliberadamente variedad: monumentos, patrimonio histórico, iglesias, ermitas, catedrales, castillos o fortalezas, edificios y arquitectura singulares, museos y espacios culturales, plazas y cascos históricos, miradores, puentes, fuentes, jardines, parques, elementos naturales y otros lugares con interés turístico real.
ORDEN Y RELEVANCIA: ordena places de mayor a menor interés para un visitante. Asigna score de 0 a 100: 90-100 = imprescindible o muy destacado; 75-89 = muy recomendable; 60-74 = interesante; 40-59 = curiosidad/solo si sobra tiempo. La aplicación mostrará este nivel al usuario para ayudarle a seleccionar manualmente. La puntuación debe reflejar principalmente interés turístico, no solo proximidad.
Mantén las coordenadas del candidato OSM elegido. Usa su nombre exacto y específico. En VISITA COMPLETA intenta llegar a 15 cuando existan suficientes candidatos razonables; en imprescindible devuelve 4-6.
JSON EXCLUSIVO:
{"places":[{"name":"nombre exacto","type":"categoría","description":"por qué merece la pena","score":95,"lat":43.123456,"lon":-1.234567}],"extras":[]}`;
 try{
  let g=await callQwen(prompt);
  if(g.ok){
    const places=parsePlaces(extractOpenAIText(g.data));
    if(places.length)return res.status(200).json({places,source:g.provider,model:g.model,attempts:g.attempts||[]});
  }
  const key=String(process.env.GEMINI_API_KEY||'').trim();
  if(!key)return res.status(502).json({error:g.missing?'Falta configurar QWEN_API_KEY en Vercel':'Qwen no devolvió lugares utilizables y no hay GEMINI_API_KEY configurada'});
  g=await callGemini(key,{contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.1,responseMimeType:'application/json'}},g.attempts||[]);
  if(!g.ok)return res.status(g.status>=500?502:g.status).json({error:g.data?.error?.message||('Gemini HTTP '+g.status),attempts:g.attempts||[]});
  const places=parsePlaces(extractText(g.data));
  if(!places.length)return res.status(502).json({error:'La IA respondió, pero no devolvió lugares utilizables',attempts:g.attempts||[]});
  return res.status(200).json({places,source:g.provider,model:g.model,attempts:g.attempts||[]});
 }catch(e){return res.status(502).json({error:e.message||'No se pudo contactar con Gemini'})}
};
