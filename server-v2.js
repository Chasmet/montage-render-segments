const express=require('express');
const cors=require('cors');
const multer=require('multer');
const ffmpegPath=require('ffmpeg-static');
const OpenAI=require('openai');
const {spawn}=require('child_process');
const {v4:uuid}=require('uuid');
const fs=require('fs');
const fsp=require('fs/promises');
const path=require('path');
const app=express();
const PORT=process.env.PORT||3000;
const TMP=path.join(__dirname,'tmp');
const UPLOADS=path.join(TMP,'uploads');
const JOBS=path.join(TMP,'jobs');
const MAX_UPLOAD_MB=Number(process.env.MAX_UPLOAD_MB||30);
const MAX_UPLOAD_BYTES=MAX_UPLOAD_MB*1024*1024;
const CLEANUP_MS=Number(process.env.CLEANUP_MS||3600000);
const TTS_MODEL=process.env.OPENAI_TTS_MODEL||'gpt-4o-mini-tts';
const TRANSCRIBE_MODEL=process.env.OPENAI_TRANSCRIBE_MODEL||'gpt-4o-mini-transcribe';
const MAX_LINES=Number(process.env.MAX_DIALOGUE_LINES||12);
let busy=false;
const openai=process.env.OPENAI_API_KEY?new OpenAI({apiKey:process.env.OPENAI_API_KEY}):null;
app.use(cors());app.use(express.json({limit:'2mb'}));app.use('/downloads',express.static(JOBS));
async function mkdir(d){await fsp.mkdir(d,{recursive:true})}
async function rm(t){if(!t)return;try{await fsp.rm(t,{recursive:true,force:true})}catch{}}
function mb(b){return Math.round((Number(b||0)/1024/1024)*10)/10}
function txt(v){return String(v||'').replace(/\s+/g,' ').trim()}
function ff(args,label='ffmpeg'){return new Promise((ok,ko)=>{const p=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});let e='';p.stderr.on('data',c=>{e+=c.toString();if(e.length>9000)e=e.slice(-9000)});p.on('error',er=>ko(new Error(label+' impossible : '+er.message)));p.on('close',(code,signal)=>{if(code===0)return ok();ko(new Error(label+' erreur code='+(code||'aucun')+' signal='+(signal||'aucun')+' '+e.split('\n').slice(-6).join('\n')))})})}
function safe(n){const b=path.basename(n||'video.mp4').replace(/[^a-zA-Z0-9._-]/g,'_');return b.endsWith('.mp4')?b:b+'.mp4'}
const upload=multer({storage:multer.diskStorage({destination:async(req,file,cb)=>{await mkdir(UPLOADS);cb(null,UPLOADS)},filename:(req,file,cb)=>cb(null,Date.now()+'-'+uuid()+(path.extname(file.originalname||'.mp4')||'.mp4'))}),limits:{fileSize:MAX_UPLOAD_BYTES}});
const PRESETS={
'jeune-energie':{voice:'alloy',instructions:'Voix française jeune, claire, dynamique et naturelle.'},
'jeune-doux':{voice:'alloy',instructions:'Voix française jeune, douce, calme et naturelle.'},
'feminin-doux':{voice:'shimmer',instructions:'Voix française féminine douce, posée et naturelle.'},
'feminin-mystere':{voice:'nova',instructions:'Voix française féminine mystérieuse, calme et naturelle.'},
'homme-naturel':{voice:'echo',instructions:'Voix française masculine naturelle et claire.'},
'homme-grave':{voice:'onyx',instructions:'Voix française masculine grave et imposante.'},
'mechant':{voice:'onyx',instructions:'Voix française grave, menaçante et lente.'},
'robot':{voice:'echo',instructions:'Voix française robotique, froide et régulière.'},
'monstre':{voice:'onyx',instructions:'Voix française très grave, lourde et menaçante.'},
'urbain-melodique':{voice:'onyx',instructions:'Voix française masculine grave, mélodique et mystérieuse.'}
};
function toSec(v){if(!v)return null;const s=String(v).trim();if(/^\d+(\.\d+)?$/.test(s))return Number(s);const m=s.match(/^(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);return m?Number(m[1])*60+Number(m[2])+Number('0.'+(m[3]||0)):null}
function stamp(sec){const s=Math.max(0,Number(sec||0));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(Math.floor(s%60)).padStart(2,'0')+'.'+String(Math.round((s%1)*100)).padStart(2,'0')}
function parse(script){return String(script||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean).map(l=>{const m=l.match(/^\s*(?:\[(\d{1,2}:\d{2}(?:\.\d{1,3})?|\d+(?:\.\d+)?)\]\s*)?(.{1,40}?)\s*[:：;\-–—]\s*(.+)$/u);return m?{start:toSec(m[1]),character:txt(m[2]).slice(0,40),text:txt(m[3]).slice(0,700)}:null}).filter(Boolean).slice(0,MAX_LINES)}
function voiceGuess(t){const x=String(t||'').toLowerCase();if(/monstre|piege|demon|peur|detruire/.test(x))return'monstre';if(/robot|analyse|systeme|alerte/.test(x))return'robot';if(/elle|reine|madame|maman|fille/.test(x))return'feminin-doux';if(/attention|danger|vite|cours/.test(x))return'jeune-energie';return'homme-naturel'}
function map(raw){try{const o=JSON.parse(String(raw||'{}'));return o&&typeof o==='object'?o:{}}catch{return{}}}
async function speech(text,key,out){if(!openai)throw new Error('OPENAI_API_KEY manquante dans Render.');const p=PRESETS[key]||PRESETS['homme-naturel'];const a=await openai.audio.speech.create({model:TTS_MODEL,voice:p.voice,input:text,instructions:p.instructions,response_format:'mp3'});await fsp.writeFile(out,Buffer.from(await a.arrayBuffer()))}
async function silence(out,d=0.45){await ff(['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','anullsrc=r=44100:cl=stereo','-t',String(d),'-c:a','libmp3lame','-b:a','96k',out],'silence')}
async function concat(files,out,list){await fsp.writeFile(list,files.map(f=>"file '"+f.replace(/'/g,"'\\''")+"'").join('\n'));await ff(['-y','-hide_banner','-loglevel','warning','-f','concat','-safe','0','-i',list,'-c:a','libmp3lame','-b:a','128k',out],'audio')}
async function mix(items,out){const args=['-y','-hide_banner','-loglevel','warning'];items.forEach(i=>args.push('-i',i.file));const ch=[];const labs=[];items.forEach((it,i)=>{const d=Math.round(Math.max(0,it.start||0)*1000);ch.push('['+i+':a]adelay='+d+'|'+d+'[a'+i+']');labs.push('[a'+i+']')});ch.push(labs.join('')+'amix=inputs='+items.length+':normalize=0,volume=1.4[out]');args.push('-filter_complex',ch.join(';'),'-map','[out]','-c:a','libmp3lame','-b:a','128k',out);await ff(args,'mix')}
async function dubbing(script,voiceMap,job){const lines=parse(script);if(!lines.length)return{audioPath:null,lines:0,characters:[]};const dir=path.join(job,'tts');await mkdir(dir);const timed=lines.some(x=>x.start!==null);if(timed){const items=[];for(let i=0;i<lines.length;i++){const line=lines[i];const out=path.join(dir,'line_'+String(i+1).padStart(3,'0')+'.mp3');await speech(line.text,voiceMap[line.character]||voiceGuess(line.text),out);items.push({file:out,start:line.start||0})}const final=path.join(job,'doublage.mp3');await mix(items,final);return{audioPath:final,lines:lines.length,characters:[...new Set(lines.map(x=>x.character))],timed:true}}const sil=path.join(dir,'silence.mp3');await silence(sil);const parts=[];for(let i=0;i<lines.length;i++){const line=lines[i];const out=path.join(dir,'line_'+String(i+1).padStart(3,'0')+'.mp3');await speech(line.text,voiceMap[line.character]||voiceGuess(line.text),out);parts.push(out,sil)}const final=path.join(job,'doublage.mp3');await concat(parts,final,path.join(dir,'list.txt'));return{audioPath:final,lines:lines.length,characters:[...new Set(lines.map(x=>x.character))],timed:false}}
async function extractAudio(input,out){await ff(['-y','-hide_banner','-loglevel','warning','-i',input,'-vn','-ac','1','-ar','16000','-t','90','-c:a','libmp3lame','-b:a','64k',out],'extraction audio')}
async function mp4(input,out){await ff(['-y','-hide_banner','-loglevel','warning','-i',input,'-map','0:v:0','-map','0:a?','-threads','1','-filter:v',"scale='min(720,iw)':-2,fps=25,format=yuv420p",'-c:v','libx264','-preset','ultrafast','-crf','30','-c:a','aac','-b:a','96k','-ar','44100','-ac','2','-movflags','+faststart',out],'mp4')}
async function mp4dub(input,audio,out){await ff(['-y','-hide_banner','-loglevel','warning','-i',input,'-i',audio,'-map','0:v:0','-map','1:a:0','-threads','1','-filter:v',"scale='min(720,iw)':-2,fps=25,format=yuv420p",'-c:v','libx264','-preset','ultrafast','-crf','30','-c:a','aac','-b:a','128k','-ar','44100','-ac','2','-movflags','+faststart',out],'mp4 double')}
app.get('/api/health',(req,res)=>res.json({ok:true,service:'openai-dubbing-mp4-v2',openaiReady:Boolean(openai),ttsModel:TTS_MODEL,transcribeModel:TRANSCRIBE_MODEL,maxUploadMb:MAX_UPLOAD_MB,maxDialogueLines:MAX_LINES,busy}));
app.get('/',(req,res)=>res.json({ok:true,message:'Backend V2 actif',openaiReady:Boolean(openai)}));
app.post('/api/analyze-video',upload.single('video'),async(req,res)=>{if(!openai)return res.status(500).json({success:false,error:'OPENAI_API_KEY manquante dans Render.'});const job=path.join(JOBS,'analyse-'+uuid());let input=req.file?.path;try{if(!input)return res.status(400).json({success:false,error:'Aucune vidéo reçue.'});await mkdir(job);const audio=path.join(job,'audio.mp3');await extractAudio(input,audio);const tr=await openai.audio.transcriptions.create({file:fs.createReadStream(audio),model:TRANSCRIBE_MODEL,response_format:'verbose_json',timestamp_granularities:['segment']});const raw=Array.isArray(tr.segments)?tr.segments:[];const segments=raw.slice(0,MAX_LINES).map((s,i)=>{const text=txt(s.text);const character='Voix '+String.fromCharCode(65+i);return{start:Number(s.start||0),end:Number(s.end||0),character,text,voice:voiceGuess(text)}}).filter(s=>s.text);const script=segments.map(s=>'['+stamp(s.start)+'] '+s.character+' : '+s.text).join('\n');const voiceMap={};segments.forEach(s=>voiceMap[s.character]=s.voice);await rm(input);input=null;setTimeout(()=>rm(job),CLEANUP_MS);res.json({success:true,message:'Analyse terminée. Corrige si besoin puis génère.',segments,script,voiceMap})}catch(e){await rm(input);await rm(job);res.status(500).json({success:false,error:e.message||'Erreur analyse vidéo.'})}});
app.post('/api/process-video',upload.single('video'),async(req,res)=>{if(busy){await rm(req.file?.path);return res.status(429).json({success:false,error:'Le serveur traite déjà une vidéo.'})}busy=true;const jobId=uuid();const job=path.join(JOBS,jobId);let input=req.file?.path;try{if(!input)return res.status(400).json({success:false,error:'Aucune vidéo reçue.'});await mkdir(job);const out=path.join(job,'final-'+safe(req.file.originalname));const inStat=await fsp.stat(input);const dub=await dubbing(req.body.script,map(req.body.voiceMap),job);if(dub.audioPath)await mp4dub(input,dub.audioPath,out);else await mp4(input,out);await rm(input);input=null;const outStat=await fsp.stat(out);setTimeout(()=>rm(job),CLEANUP_MS);res.json({success:true,message:dub.audioPath?'MP4 doublé généré.':'MP4 généré sans doublage.',jobId,renderMode:dub.audioPath?'openai-dubbing-v2':'light',dubbing:{enabled:Boolean(dub.audioPath),lines:dub.lines,characters:dub.characters,timed:Boolean(dub.timed),audioDownloadUrl:dub.audioPath?'/downloads/'+jobId+'/doublage.mp3':null},input:{sizeMb:mb(inStat.size)},output:{sizeMb:mb(outStat.size)},downloadUrl:'/downloads/'+jobId+'/'+path.basename(out)})}catch(e){await rm(input);await rm(job);res.status(500).json({success:false,error:e.message||'Erreur traitement vidéo.'})}finally{busy=false}});
app.use((err,req,res,next)=>{if(err.code==='LIMIT_FILE_SIZE')return res.status(413).json({success:false,error:'Fichier trop lourd. Maximum conseillé : '+MAX_UPLOAD_MB+' Mo.'});res.status(500).json({success:false,error:err.message||'Erreur serveur.'})});
async function boot(){await mkdir(TMP);await mkdir(UPLOADS);await mkdir(JOBS);app.listen(PORT,()=>console.log('Backend V2 actif sur port '+PORT))}
boot();
