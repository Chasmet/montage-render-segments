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
const MAX_LINES=Number(process.env.MAX_DIALOGUE_LINES||12);
const TTS_MODEL=process.env.OPENAI_TTS_MODEL||'gpt-4o-mini-tts';
const TRANSCRIBE_MODEL=process.env.OPENAI_TRANSCRIBE_MODEL||'gpt-4o-mini-transcribe';
const openai=process.env.OPENAI_API_KEY?new OpenAI({apiKey:process.env.OPENAI_API_KEY}):null;
let busy=false;

app.use(cors());
app.use(express.json({limit:'2mb'}));
app.use('/downloads',express.static(JOBS));

async function mkdir(d){await fsp.mkdir(d,{recursive:true})}
async function rm(p){if(!p)return;try{await fsp.rm(p,{recursive:true,force:true})}catch{}}
function clean(v){return String(v||'').replace(/\s+/g,' ').trim()}
function mb(b){return Math.round((Number(b||0)/1024/1024)*10)/10}
function safeName(n){const b=path.basename(n||'video.mp4').replace(/[^a-zA-Z0-9._-]/g,'_');return b.endsWith('.mp4')?b:b+'.mp4'}
function run(args,label){return new Promise((ok,ko)=>{const p=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',c=>{err+=c.toString();if(err.length>9000)err=err.slice(-9000)});p.on('error',e=>ko(new Error(label+' impossible : '+e.message)));p.on('close',(code,signal)=>{if(code===0)return ok();ko(new Error(label+' erreur code='+(code||'aucun')+' signal='+(signal||'aucun')+' '+err.split('\n').slice(-6).join('\n')))})})}

const upload=multer({storage:multer.diskStorage({destination:async(req,file,cb)=>{await mkdir(UPLOADS);cb(null,UPLOADS)},filename:(req,file,cb)=>cb(null,Date.now()+'-'+uuid()+(path.extname(file.originalname||'.mp4')||'.mp4'))}),limits:{fileSize:MAX_UPLOAD_MB*1024*1024}});

const VOICES={
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
function guessVoice(t){const x=String(t||'').toLowerCase();if(/robot|système|systeme|alerte|analyse/.test(x))return'robot';if(/monstre|piège|piege|démon|demon|peur/.test(x))return'monstre';if(/fille|femme|maman|reine|elle/.test(x))return'feminin-doux';if(/vite|cours|danger|attention/.test(x))return'jeune-energie';return'homme-naturel'}
function timeToSec(v){if(!v)return null;const s=String(v).trim();if(/^\d+(\.\d+)?$/.test(s))return Number(s);const m=s.match(/^(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);return m?Number(m[1])*60+Number(m[2])+Number('0.'+(m[3]||0)):null}
function stamp(sec){const s=Math.max(0,Number(sec||0));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(Math.floor(s%60)).padStart(2,'0')+'.'+String(Math.round((s%1)*100)).padStart(2,'0')}
function parseScript(script){return String(script||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean).map(x=>{const m=x.match(/^\s*(?:\[(\d{1,2}:\d{2}(?:\.\d{1,3})?|\d+(?:\.\d+)?)\]\s*)?(.{1,40}?)\s*[:：;\-–—]\s*(.+)$/u);return m?{start:timeToSec(m[1]),name:clean(m[2]).slice(0,40),text:clean(m[3]).slice(0,700)}:null}).filter(Boolean).slice(0,MAX_LINES)}
function parseMap(raw){try{const o=JSON.parse(String(raw||'{}'));return o&&typeof o==='object'?o:{}}catch{return{}}}
async function speech(text,key,out){if(!openai)throw new Error('OPENAI_API_KEY manquante dans Render.');const p=VOICES[key]||VOICES['homme-naturel'];const audio=await openai.audio.speech.create({model:TTS_MODEL,voice:p.voice,input:text,instructions:p.instructions,response_format:'mp3'});await fsp.writeFile(out,Buffer.from(await audio.arrayBuffer()))}
async function makeDubbing(script,voiceMap,job){const lines=parseScript(script);if(!lines.length)return{audio:null,lines:0,characters:[]};const dir=path.join(job,'tts');await mkdir(dir);const inputs=[];for(let i=0;i<lines.length;i++){const line=lines[i];const file=path.join(dir,'line_'+String(i+1).padStart(3,'0')+'.mp3');await speech(line.text,voiceMap[line.name]||guessVoice(line.text),file);inputs.push({file,start:line.start??(i*2.4)})}
const args=['-y','-hide_banner','-loglevel','warning'];inputs.forEach(x=>args.push('-i',x.file));const graph=[];const labels=[];inputs.forEach((x,i)=>{const delay=Math.max(0,Math.round(Number(x.start||0)*1000));graph.push('['+i+':a]adelay='+delay+'|'+delay+'[a'+i+']');labels.push('[a'+i+']')});graph.push(labels.join('')+'amix=inputs='+inputs.length+':normalize=0,volume=1.4[out]');const output=path.join(job,'doublage.mp3');args.push('-filter_complex',graph.join(';'),'-map','[out]','-c:a','libmp3lame','-b:a','128k',output);await run(args,'mix doublage synchronisé');return{audio:output,lines:lines.length,characters:[...new Set(lines.map(x=>x.name))]}}
async function makeMp4(input,audio,out){await run(['-y','-hide_banner','-loglevel','warning','-i',input,'-i',audio,'-map','0:v:0','-map','1:a:0','-threads','1','-filter:v',"scale='min(720,iw)':-2,fps=25,format=yuv420p",'-c:v','libx264','-preset','ultrafast','-crf','30','-c:a','aac','-b:a','128k','-ar','44100','-ac','2','-movflags','+faststart',out],'MP4 doublé sans audio Grok')}
async function extractAudio(input,out){await run(['-y','-hide_banner','-loglevel','warning','-i',input,'-vn','-ac','1','-ar','16000','-t','90','-c:a','libmp3lame','-b:a','64k',out],'extraction audio')}
function approxSegments(text){const parts=clean(text).split(/(?<=[.!?…])\s+/).map(clean).filter(Boolean).slice(0,MAX_LINES);let t=0;return parts.map((p,i)=>{const dur=Math.max(1.6,Math.min(4.5,p.length/18));const seg={start:t,end:t+dur,character:'Voix '+String.fromCharCode(65+i),text:p,voice:guessVoice(p)};t+=dur+0.25;return seg})}

app.get('/',(req,res)=>res.json({ok:true,message:'Backend V2 revenu à la base : audio Grok coupé, voix OpenAI synchronisée',openaiReady:Boolean(openai)}));
app.get('/api/health',(req,res)=>res.json({ok:true,service:'openai-dubbing-mp4-v2-replace-audio',openaiReady:Boolean(openai),ttsModel:TTS_MODEL,transcribeModel:TRANSCRIBE_MODEL,audioMode:'replace-grok-audio-with-openai-timed',maxUploadMb:MAX_UPLOAD_MB,maxDialogueLines:MAX_LINES,busy}));

app.post('/api/analyze-video',upload.single('video'),async(req,res)=>{const job=path.join(JOBS,'analyse-'+uuid());let input=req.file?.path;try{if(!openai)throw new Error('OPENAI_API_KEY manquante dans Render.');if(!input)throw new Error('Aucune vidéo reçue.');await mkdir(job);const audio=path.join(job,'audio.mp3');await extractAudio(input,audio);let tr;try{tr=await openai.audio.transcriptions.create({file:fs.createReadStream(audio),model:TRANSCRIBE_MODEL,response_format:'verbose_json',timestamp_granularities:['segment']})}catch(e){tr=await openai.audio.transcriptions.create({file:fs.createReadStream(audio),model:TRANSCRIBE_MODEL,response_format:'json'})}const raw=Array.isArray(tr.segments)?tr.segments:[];let segments=raw.slice(0,MAX_LINES).map((s,i)=>{const text=clean(s.text);return{start:Number(s.start||0),end:Number(s.end||0),character:'Voix '+String.fromCharCode(65+i),text,voice:guessVoice(text)}}).filter(x=>x.text);if(!segments.length)segments=approxSegments(tr.text||'');const script=segments.map(s=>'['+stamp(s.start)+'] '+s.character+' : '+s.text).join('\n');const voiceMap={};segments.forEach(s=>voiceMap[s.character]=s.voice);await rm(input);input=null;setTimeout(()=>rm(job),60*60*1000);res.json({success:true,message:'Analyse terminée. Le MP4 final coupera le son Grok et mettra OpenAI à la place.',segments,script,voiceMap,estimatedTiming:!raw.length})}catch(error){await rm(input);await rm(job);res.status(500).json({success:false,error:error.message||'Erreur analyse vidéo.'})}});

app.post('/api/process-video',upload.single('video'),async(req,res)=>{if(busy){await rm(req.file?.path);return res.status(429).json({success:false,error:'Le serveur traite déjà une vidéo.'})}busy=true;const jobId=uuid();const job=path.join(JOBS,jobId);let input=req.file?.path;try{if(!input)throw new Error('Aucune vidéo reçue.');await mkdir(job);const inputStat=await fsp.stat(input);const dub=await makeDubbing(req.body.script,parseMap(req.body.voiceMap),job);if(!dub.audio)throw new Error('Aucune réplique détectée.');const output=path.join(job,'final-'+safeName(req.file.originalname));await makeMp4(input,dub.audio,output);await rm(input);input=null;const outputStat=await fsp.stat(output);setTimeout(()=>rm(job),60*60*1000);res.json({success:true,message:'MP4 doublé généré : son Grok coupé, OpenAI synchronisé.',jobId,renderMode:'replace-grok-audio-openai-timed',dubbing:{enabled:true,lines:dub.lines,characters:dub.characters,timed:true,backgroundKept:false,audioDownloadUrl:'/downloads/'+jobId+'/doublage.mp3'},input:{sizeMb:mb(inputStat.size)},output:{sizeMb:mb(outputStat.size)},downloadUrl:'/downloads/'+jobId+'/'+path.basename(output)})}catch(error){await rm(input);await rm(job);res.status(500).json({success:false,error:error.message||'Erreur traitement vidéo.'})}finally{busy=false}});

app.use((err,req,res,next)=>{if(err.code==='LIMIT_FILE_SIZE')return res.status(413).json({success:false,error:'Fichier trop lourd. Maximum conseillé : '+MAX_UPLOAD_MB+' Mo.'});res.status(500).json({success:false,error:err.message||'Erreur serveur.'})});
(async()=>{await mkdir(TMP);await mkdir(UPLOADS);await mkdir(JOBS);app.listen(PORT,()=>console.log('Backend V2 replace audio actif sur port '+PORT))})();
