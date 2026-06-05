const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpegPath = require('ffmpeg-static');
const OpenAI = require('openai');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const fsp = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TMP = path.join(__dirname, 'tmp');
const UPLOADS = path.join(TMP, 'uploads');
const JOBS = path.join(TMP, 'jobs');

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 30);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const CLEANUP_MS = Number(process.env.CLEANUP_MS || 60 * 60 * 1000);
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const MAX_DIALOGUE_LINES = Number(process.env.MAX_DIALOGUE_LINES || 12);

let busy = false;
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/downloads', express.static(JOBS));

async function mkdir(dir) { await fsp.mkdir(dir, { recursive: true }); }
async function rm(target) { if (!target) return; try { await fsp.rm(target, { recursive: true, force: true }); } catch {} }
function toMb(bytes) { return Math.round((Number(bytes || 0) / 1024 / 1024) * 10) / 10; }
function cleanText(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }

function runFfmpeg(args, label = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 10000) stderr = stderr.slice(-10000);
    });
    child.on('error', err => reject(new Error(`${label} impossible à lancer : ${err.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      const detail = stderr.trim().split('\n').slice(-8).join('\n');
      reject(new Error(`${label} a échoué. Code=${code || 'aucun'} Signal=${signal || 'aucun'} ${detail ? `\n${detail}` : ''}`));
    });
  });
}

function safeOutputName(fileName) {
  const base = path.basename(fileName || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.endsWith('.mp4') ? base : `${base}.mp4`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => { await mkdir(UPLOADS); cb(null, UPLOADS); },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${uuid()}${path.extname(file.originalname || '.mp4') || '.mp4'}`)
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

const VOICE_PRESETS = {
  'jeune-energie': { voice: 'alloy', instructions: 'Voix française jeune, claire, dynamique, naturelle, avec une bonne énergie.' },
  'jeune-doux': { voice: 'alloy', instructions: 'Voix française jeune, douce, calme, naturelle et très lisible.' },
  'feminin-doux': { voice: 'shimmer', instructions: 'Voix française féminine douce, posée, chaleureuse et naturelle.' },
  'feminin-mystere': { voice: 'nova', instructions: 'Voix française féminine calme, mystérieuse, cinématographique et naturelle.' },
  'homme-naturel': { voice: 'echo', instructions: 'Voix française masculine naturelle, claire, simple et réaliste.' },
  'homme-grave': { voice: 'onyx', instructions: 'Voix française masculine grave, posée, profonde et imposante.' },
  'mechant': { voice: 'onyx', instructions: 'Voix française grave, menaçante, lente, théâtrale mais compréhensible.' },
  'robot': { voice: 'echo', instructions: 'Voix française robotique, froide, régulière, mécanique, avec une diction nette.' },
  'monstre': { voice: 'onyx', instructions: 'Voix française très grave, lourde, menaçante, lente, sans crier.' },
  'urbain-melodique': { voice: 'onyx', instructions: 'Voix française masculine grave, mélodique, pop urbaine mystérieuse, posée et charismatique. Ne copie aucune personne réelle.' }
};

function parseDialogue(script) {
  return String(script || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^([^:：]{1,40})\s*[:：]\s*(.+)$/);
      if (!match) return null;
      return { character: cleanText(match[1]).slice(0, 40), text: cleanText(match[2]).slice(0, 700) };
    })
    .filter(Boolean)
    .slice(0, MAX_DIALOGUE_LINES);
}

function parseVoiceMap(raw) {
  try { const obj = JSON.parse(String(raw || '{}')); return obj && typeof obj === 'object' ? obj : {}; } catch { return {}; }
}

async function generateSpeech(text, presetKey, output) {
  if (!openai) throw new Error('OPENAI_API_KEY manquante dans Render.');
  const preset = VOICE_PRESETS[presetKey] || VOICE_PRESETS['homme-naturel'];
  const audio = await openai.audio.speech.create({
    model: TTS_MODEL,
    voice: preset.voice,
    input: text,
    instructions: preset.instructions,
    response_format: 'mp3'
  });
  await fsp.writeFile(output, Buffer.from(await audio.arrayBuffer()));
}

async function makeSilence(output, duration = 0.45) {
  await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','anullsrc=r=44100:cl=stereo','-t',String(duration),'-c:a','libmp3lame','-b:a','96k',output], 'création silence');
}

async function concatAudios(files, output, listFile) {
  await fsp.writeFile(listFile, files.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
  await runFfmpeg(['-y','-hide_banner','-loglevel','warning','-f','concat','-safe','0','-i',listFile,'-c:a','libmp3lame','-b:a','128k',output], 'assemblage audio');
}

async function createDubbingAudio(script, voiceMap, jobDir) {
  const dialogue = parseDialogue(script);
  if (!dialogue.length) return { audioPath: null, lines: 0, characters: [] };

  const audioDir = path.join(jobDir, 'tts');
  await mkdir(audioDir);
  const silence = path.join(audioDir, 'silence.mp3');
  await makeSilence(silence);

  const parts = [];
  for (let i = 0; i < dialogue.length; i++) {
    const item = dialogue[i];
    const voice = voiceMap[item.character] || 'homme-naturel';
    const out = path.join(audioDir, `line_${String(i + 1).padStart(3, '0')}.mp3`);
    await generateSpeech(item.text, voice, out);
    parts.push(out, silence);
  }

  const finalAudio = path.join(jobDir, 'doublage.mp3');
  await concatAudios(parts, finalAudio, path.join(audioDir, 'audio-list.txt'));
  return { audioPath: finalAudio, lines: dialogue.length, characters: [...new Set(dialogue.map(d => d.character))] };
}

async function makeMp4Light(input, output) {
  await runFfmpeg(['-y','-hide_banner','-loglevel','warning','-i',input,'-map','0:v:0','-map','0:a?','-threads','1','-filter:v',"scale='min(720,iw)':-2,fps=25,format=yuv420p",'-c:v','libx264','-preset','ultrafast','-tune','fastdecode','-crf','30','-maxrate','1200k','-bufsize','2400k','-c:a','aac','-b:a','96k','-ar','44100','-ac','2','-movflags','+faststart','-max_muxing_queue_size','1024',output], 'conversion MP4 légère');
}

async function makeDubbedMp4(input, audio, output) {
  await runFfmpeg(['-y','-hide_banner','-loglevel','warning','-i',input,'-i',audio,'-map','0:v:0','-map','1:a:0','-threads','1','-filter:v',"scale='min(720,iw)':-2,fps=25,format=yuv420p",'-c:v','libx264','-preset','ultrafast','-tune','fastdecode','-crf','30','-maxrate','1200k','-bufsize','2400k','-c:a','aac','-b:a','128k','-ar','44100','-ac','2','-movflags','+faststart','-max_muxing_queue_size','1024',output], 'création MP4 doublé');
}

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Backend actif - MP4 + doublage OpenAI', openaiReady: Boolean(openai), maxUploadMb: MAX_UPLOAD_MB, maxDialogueLines: MAX_DIALOGUE_LINES });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'openai-dubbing-mp4', openaiReady: Boolean(openai), ttsModel: TTS_MODEL, maxUploadMb: MAX_UPLOAD_MB, maxDialogueLines: MAX_DIALOGUE_LINES, busy });
});

app.post('/api/process-video', upload.single('video'), async (req, res) => {
  if (busy) {
    await rm(req.file?.path);
    return res.status(429).json({ success: false, error: 'Le serveur traite déjà une vidéo. Réessaie dans quelques secondes.' });
  }

  busy = true;
  const jobId = uuid();
  const jobDir = path.join(JOBS, jobId);
  let input = req.file?.path;

  try {
    if (!input) return res.status(400).json({ success: false, error: 'Aucune vidéo reçue.' });
    await mkdir(jobDir);

    const outputMp4 = path.join(jobDir, `final-${safeOutputName(req.file.originalname)}`);
    const inputStat = await fsp.stat(input);
    const voiceMap = parseVoiceMap(req.body.voiceMap);
    const dubbing = await createDubbingAudio(req.body.script, voiceMap, jobDir);

    if (dubbing.audioPath) await makeDubbedMp4(input, dubbing.audioPath, outputMp4);
    else await makeMp4Light(input, outputMp4);

    await rm(input);
    input = null;
    const outputStat = await fsp.stat(outputMp4);
    setTimeout(() => rm(jobDir), CLEANUP_MS);

    res.json({
      success: true,
      message: dubbing.audioPath ? 'MP4 doublé avec OpenAI généré.' : 'MP4 généré sans doublage.',
      jobId,
      renderMode: dubbing.audioPath ? 'openai-dubbing-light-720p' : 'light-720p-threads1',
      dubbing: { enabled: Boolean(dubbing.audioPath), lines: dubbing.lines, characters: dubbing.characters, audioDownloadUrl: dubbing.audioPath ? `/downloads/${jobId}/doublage.mp3` : null },
      input: { sizeMb: toMb(inputStat.size) },
      output: { sizeMb: toMb(outputStat.size) },
      downloadUrl: `/downloads/${jobId}/${path.basename(outputMp4)}`
    });
  } catch (error) {
    await rm(input);
    await rm(jobDir);
    res.status(500).json({ success: false, error: error.message || 'Erreur traitement vidéo.' });
  } finally {
    busy = false;
  }
});

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: `Fichier trop lourd. Maximum conseillé : ${MAX_UPLOAD_MB} Mo.` });
  res.status(500).json({ success: false, error: err.message || 'Erreur serveur.' });
});

async function boot() {
  await mkdir(TMP); await mkdir(UPLOADS); await mkdir(JOBS);
  app.listen(PORT, () => console.log(`Backend actif sur port ${PORT}. OpenAI=${openai ? 'OK' : 'manquant'}`));
}

boot();
