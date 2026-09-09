const H={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
function extractText(d){return (d?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim()}
const GEMINI_MODELS=['gemini-3.6-flash','gemini-3.5-flash','gemini-3.5-flash-lite'];
const QWEN_MODELS=String(process.env.QWEN_MODELS||'qwen3.8-flash,qwen3.7-flash,qwen3.6-flash,qwen3.5-flash').split(',').map(x=>x.trim()).filter(Boolean);
const QWEN_BASE=String(process.env.QWEN_BASE_URL||'https://trial.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions').trim().replace(/\/$/,'');
function extractOpenAIText(d){return String(d?.choices?.[0]?.message?.content||'').trim()}
async function callQwen(payload){
 const key=String(process.env.QWEN_API_KEY||'').trim();
 if(!key)return {ok:false,missing:true,status:0,data:{}};
 let last={ok:false,status:502,data:{},model:QWEN_MODELS[0],provider:'Qwen'};
 for(const model of QWEN_MODELS){
  const r=await fetch(QWEN_BASE,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+key},body:JSON.stringify({model,messages:[{role:'user',content:payload}],temperature:0.1,response_format:{type:'json_object'}})});
  const d=await r.json().catch(()=>({})); last={ok:r.ok,status:r.status,data:d,model,provider:'Qwen'};
  if(r.ok)return last;
  if(![429,500,502,503,504].includes(r.status))break;
 }
 return last;
}
async function callGemini(key,payload){
 let last={status:502,data:{}};
 for(const model of GEMINI_MODELS){
  const url='https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent?key='+encodeURIComponent(key);
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const d=await r.json().catch(()=>({})); last={status:r.status,data:d,model,provider:'Gemini'};
  if(r.ok)return {ok:true,status:r.status,data:d,model,provider:'Gemini'};
  if(r.status!==429) break;
 }
 return {ok:false,...last};
}
function parsePlaces(text){
 text=String(text||'').trim().replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/\s*```$/,'');
 let a;try{a=JSON.parse(text)}catch(e){const i=text.indexOf('['),j=text.lastIndexOf(']');if(i<0||j<i)throw new Error('La IA no devolvió JSON válido');a=JSON.parse(text.slice(i,j+1))}
 const seen=new Set();
 return (Array.isArray(a)?a:[]).map((x,i)=>({name:String(x?.name||'').trim(),type:String(x?.type||'lugar de interés').trim(),description:String(x?.description||'').trim(),score:Number(x?.score)||100-i*5,lat:Number(x?.lat),lon:Number(x?.lon)})).filter(x=>x.name&&!seen.has(x.name.toLowerCase())&&(seen.add(x.name.toLowerCase()),true)).slice(0,15);
}
module.exports=async (req,res)=>{
 if(req.method!=='POST')return res.status(405).json({error:'Usa POST'});
 const b=req.body||{};
 const name=String(b.name||'').trim(), context=String(b.context||name).trim();
 const lat=Number(b.lat),lon=Number(b.lon),prefs=b.preferences||{};
 if(!name)return res.status(400).json({error:'Falta el lugar'});
 const movement=prefs.movement==='driving'?'EN COCHE':(prefs.movement==='bicycling'?'EN BICICLETA':'ANDANDO');
 const amount=prefs.amount==='complete'?'VISITA COMPLETA (puedes proponer más lugares interesantes)':'SOLO LO IMPRESCINDIBLE (selección corta y muy buena)';
 const notes=String(prefs.notes||'').trim();
 const prompt=`Eres un experto guía turístico local. Debes preparar una selección para una persona que va a VISITAR ${context}.
CENTRO EXACTO: ${name}, coordenadas ${lat}, ${lon}.
PREFERENCIAS: se moverá ${movement}; quiere ${amount}; petición libre: ${notes||'ninguna'}.
Prioriza SIEMPRE lugares cercanos al centro exacto. Andando mantén una selección compacta; en bici permite algo más; en coche puedes ampliar. Si pide pueblos cercanos o una distancia concreta, respétala. Evita recomendar homónimos o lugares lejanos.
Prioriza calidad turística real. No inventes ni incluyas servicios, tiendas, farmacias, restaurantes, hoteles o parkings.
MUY IMPORTANTE: usa el nombre exacto y específico por el que se localiza el punto en un mapa (incluye monumento/edificio concreto y localidad cuando ayude). La aplicación verificará las coordenadas posteriormente con un geocodificador real.
Devuelve aproximadamente ${prefs.amount==='complete'?'6 a 12':'4 a 6'} resultados. JSON EXCLUSIVO:
[{"name":"nombre exacto","type":"categoría","description":"por qué merece la pena","score":100,"lat":43.123456,"lon":-1.234567}]`;
 try{
  let g=await callQwen(prompt);
  if(g.ok){
    const places=parsePlaces(extractOpenAIText(g.data));
    if(places.length)return res.status(200).json({places,source:g.provider,model:g.model});
  }
  const key=String(process.env.GEMINI_API_KEY||'').trim();
  if(!key)return res.status(502).json({error:g.missing?'Falta configurar QWEN_API_KEY en Vercel':'Qwen no devolvió lugares utilizables y no hay GEMINI_API_KEY configurada'});
  g=await callGemini(key,{contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.1,responseMimeType:'application/json'}});
  if(!g.ok)return res.status(g.status>=500?502:g.status).json({error:g.data?.error?.message||('Gemini HTTP '+g.status)});
  const places=parsePlaces(extractText(g.data));
  if(!places.length)return res.status(502).json({error:'La IA respondió, pero no devolvió lugares utilizables'});
  return res.status(200).json({places,source:g.provider,model:g.model});
 }catch(e){return res.status(502).json({error:e.message||'No se pudo contactar con Gemini'})}
};
