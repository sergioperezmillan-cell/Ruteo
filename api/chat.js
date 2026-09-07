function extractText(d){return (d?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim()}
const GEMINI_MODELS=['gemini-3.6-flash','gemini-3.5-flash','gemini-3.5-flash-lite'];
async function callGemini(key,payload){
 let last={status:502,data:{}};
 for(const model of GEMINI_MODELS){
  const url='https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent?key='+encodeURIComponent(key);
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const d=await r.json().catch(()=>({})); last={status:r.status,data:d,model};
  if(r.ok)return {ok:true,status:r.status,data:d,model};
  if(r.status!==429) break;
 }
 return {ok:false,...last};
}
function parse(t){try{return JSON.parse(t)}catch(e){let i=t.indexOf('{'),j=t.lastIndexOf('}');if(i>=0&&j>i)return JSON.parse(t.slice(i,j+1));throw e}}
module.exports=async(req,res)=>{if(req.method!=='POST')return res.status(405).json({error:'Usa POST'});const b=req.body||{},key=String(process.env.GEMINI_API_KEY||'').trim();if(!key)return res.status(500).json({error:'Falta GEMINI_API_KEY en Vercel'});const dest=String(b.destination||''),msg=String(b.message||''),hist=Array.isArray(b.history)?b.history.slice(-12):[];if(!dest||!msg)return res.status(400).json({error:'Faltan datos'});const tr=hist.map(x=>`${x.role==='user'?'USUARIO':'ASISTENTE'}: ${x.text}`).join('\n');const prompt=`Eres el asistente turístico conversacional de Ruteo. Destino base: ${dest}, coordenadas ${b.lat}, ${b.lon}. Conversa naturalmente y recuerda la lista de lugares. El usuario puede añadir o quitar sitios y pedir sitios cerca o lejos: respeta su intención sin imponer radios. No inventes lugares ni coordenadas.\n${tr}\nUSUARIO: ${msg}\nResponde SOLO JSON: {"reply":"respuesta breve en español","places":[{"name":"nombre exacto para Google Maps","type":"categoría","description":"motivo breve","score":100,"lat":43.123456,"lon":-1.234567}]}. Mantén en places la lista completa actual. Coordenadas reales y exactas; si no estás seguro no incluyas el sitio.`;try{const g=await callGemini(key,{contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:.2,responseMimeType:'application/json'}});if(!g.ok)return res.status(g.status).json({error:g.data?.error?.message||'Error Gemini'});const o=parse(extractText(g.data)),seen=new Set(),places=(Array.isArray(o.places)?o.places:[]).map((x,i)=>({name:String(x.name||'').trim(),type:String(x.type||'lugar de interés'),description:String(x.description||''),score:Number(x.score)||100-i,lat:Number(x.lat),lon:Number(x.lon)})).filter(x=>x.name&&Number.isFinite(x.lat)&&Number.isFinite(x.lon)&&!seen.has(x.name.toLowerCase())&&(seen.add(x.name.toLowerCase()),true));return res.json({reply:String(o.reply||'He actualizado la propuesta.'),places})}catch(e){return res.status(502).json({error:e.message||'Error'})}};
