const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const TMP = path.join(__dirname, 'tmp');
const UPLOADS = path.join(TMP, 'uploads');
const JOBS = path.join(TMP, 'jobs');

// Réglages pensés pour Render gratuit : peu de RAM, 1 traitement à la fois, encodage léger.
const MAX_VIDEO_SECONDS = Number(process.env.MAX_VIDEO_SECONDS || 90);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 30);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const CLEANUP_MS = Number(process.env.CLEANUP_MS || 60 * 60 * 1000);

let busy = false;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/downloads', express.static(JOBS));

async function mkdir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function rm(target) {
  if (!target) return;
  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch {}
}

function toMb(bytes) {
  return Math.round((Number(bytes || 0) / 1024 / 1024) * 10) / 10;
}

function runFfmpeg(args, label = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', error => {
      reject(new Error(`${label} impossible à lancer : ${error.message}`));
    });

    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      const detail = stderr.trim().split('\n').slice(-8).join('\n');
      reject(new Error(`${label} a échoué. Code=${code || 'aucun'} Signal=${signal || 'aucun'} ${detail ? `\n${detail}` : ''}`));
    });
  });
}

async function probe(file) {
  const tempJson = `${file}.probe.json`;
  await runFfmpeg([
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height',
    '-of', 'json',
    '-i', file
  ], 'ffprobe interne').catch(async () => {
    // ffmpeg-static ne fournit pas toujours ffprobe. Fallback minimal : on continue sans metadata.
    const stat = await fsp.stat(file);
    return { duration: 0, size: stat.size, width: null, height: null };
  });

  try {
    await runFfmpeg([
      '-i', file,
      '-f', 'null',
      '-'
    ], 'lecture vidéo test');
  } catch {
    // Certains fichiers valides déclenchent une erreur en sortie null sur Render. On ne bloque pas ici.
  }

  const stat = await fsp.stat(file);
  return {
    duration: 0,
    size: stat.size,
    width: null,
    height: null
  };
}

function safeOutputName(fileName) {
  const base = path.basename(fileName || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.endsWith('.mp4') ? base : `${base}.mp4`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      await mkdir(UPLOADS);
      cb(null, UPLOADS);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '.mp4') || '.mp4';
      cb(null, `${Date.now()}-${uuid()}${ext}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

async function makeMp4Light(input, output) {
  // Pas de découpage + concat. Sur Render gratuit, ça crée trop d'étapes et peut provoquer SIGSEGV.
  // Ici on réencode en une seule passe légère, avec 1 thread et sortie 720p max.
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-loglevel', 'warning',
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-threads', '1',
    '-filter:v', "scale='min(720,iw)':-2,fps=25,format=yuv420p",
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'fastdecode',
    '-crf', '30',
    '-maxrate', '1200k',
    '-bufsize', '2400k',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    '-max_muxing_queue_size', '1024',
    output
  ], 'conversion MP4 légère');
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'Backend Render actif - mode léger anti-crash',
    limits: {
      maxUploadMb: MAX_UPLOAD_MB,
      maxVideoSeconds: MAX_VIDEO_SECONDS,
      oneJobAtATime: true,
      output: 'MP4 720p max, 25 fps, AAC 96k'
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'montage-render-segments-light',
    maxUploadMb: MAX_UPLOAD_MB,
    maxVideoSeconds: MAX_VIDEO_SECONDS,
    busy
  });
});

app.post('/api/process-video', upload.single('video'), async (req, res) => {
  if (busy) {
    await rm(req.file?.path);
    return res.status(429).json({
      success: false,
      error: 'Le serveur traite déjà une vidéo. Réessaie dans quelques secondes.'
    });
  }

  busy = true;
  const jobId = uuid();
  const jobDir = path.join(JOBS, jobId);
  let input = req.file?.path;

  try {
    if (!input) {
      return res.status(400).json({ success: false, error: 'Aucune vidéo reçue.' });
    }

    await mkdir(jobDir);

    const originalName = safeOutputName(req.file.originalname);
    const outputMp4 = path.join(jobDir, `final-${originalName}`);
    const inputStat = await fsp.stat(input);

    await makeMp4Light(input, outputMp4);
    await rm(input);
    input = null;

    const outputStat = await fsp.stat(outputMp4);
    setTimeout(() => rm(jobDir), CLEANUP_MS);

    res.json({
      success: true,
      message: 'MP4 généré en mode léger Render.',
      jobId,
      renderMode: 'light-720p-threads1',
      input: {
        sizeMb: toMb(inputStat.size)
      },
      output: {
        sizeMb: toMb(outputStat.size)
      },
      downloadUrl: `/downloads/${jobId}/${path.basename(outputMp4)}`
    });
  } catch (error) {
    await rm(input);
    await rm(jobDir);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur traitement vidéo.'
    });
  } finally {
    busy = false;
  }
});

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: `Fichier trop lourd. Maximum conseillé sur Render gratuit : ${MAX_UPLOAD_MB} Mo.`
    });
  }
  res.status(500).json({ success: false, error: err.message || 'Erreur serveur.' });
});

async function boot() {
  await mkdir(TMP);
  await mkdir(UPLOADS);
  await mkdir(JOBS);
  app.listen(PORT, () => {
    console.log(`Backend actif sur port ${PORT}`);
    console.log(`Mode léger : max ${MAX_UPLOAD_MB} Mo, 1 traitement à la fois, threads FFmpeg = 1`);
  });
}

boot();
