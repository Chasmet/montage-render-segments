const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

const TMP_ROOT = path.join(__dirname, 'tmp');
const UPLOAD_DIR = path.join(TMP_ROOT, 'uploads');
const JOBS_DIR = path.join(TMP_ROOT, 'jobs');

const SEGMENT_DURATION_SECONDS = Number(process.env.SEGMENT_DURATION_SECONDS || 10);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 150);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_SEGMENTS = Number(process.env.MAX_SEGMENTS || 60);
const FINAL_FILE_TTL_MS = Number(process.env.FINAL_FILE_TTL_MS || 60 * 60 * 1000);
const EXPORT_PRESET = process.env.EXPORT_PRESET || 'veryfast';
const EXPORT_CRF = process.env.EXPORT_CRF || '18';
const EXPORT_FPS = process.env.EXPORT_FPS || '30';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/downloads', express.static(JOBS_DIR));

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function safeRemove(targetPath) {
  if (!targetPath) return;
  try {
    await fsp.rm(targetPath, { recursive: true, force: true });
  } catch (error) {
    console.error('Erreur suppression:', targetPath, error.message);
  }
}

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command
      .on('start', (cmd) => console.log('FFmpeg:', cmd))
      .on('progress', (progress) => {
        if (progress.percent) console.log(`Progression: ${Math.round(progress.percent)}%`);
      })
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function getVideoInfo(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (error, metadata) => {
      if (error) return reject(error);

      const videoStream = metadata.streams.find((stream) => stream.codec_type === 'video');
      const audioStream = metadata.streams.find((stream) => stream.codec_type === 'audio');

      resolve({
        duration: Number(metadata.format.duration || 0),
        size: Number(metadata.format.size || 0),
        videoCodec: videoStream?.codec_name || null,
        width: videoStream?.width || null,
        height: videoStream?.height || null,
        fps: videoStream?.r_frame_rate || null,
        audioCodec: audioStream?.codec_name || null
      });
    });
  });
}

async function getFolderSizeBytes(folderPath) {
  let total = 0;

  async function walk(currentPath) {
    const entries = await fsp.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const stat = await fsp.stat(fullPath);
        total += stat.size;
      }
    }
  }

  try {
    await walk(folderPath);
  } catch {
    return 0;
  }

  return total;
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await ensureDir(UPLOAD_DIR);
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.mp4').toLowerCase() || '.mp4';
    cb(null, `${Date.now()}-${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'video/mp4',
      'video/quicktime',
      'video/x-matroska',
      'video/webm',
      'video/x-msvideo'
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Format vidéo non accepté. Utilise MP4, MOV, MKV, WEBM ou AVI.'));
    }

    cb(null, true);
  }
});

async function splitIntoSegments(inputPath, segmentsDir) {
  await ensureDir(segmentsDir);

  const outputPattern = path.join(segmentsDir, 'segment_%03d.mp4');

  await runFfmpeg(
    ffmpeg(inputPath)
      .outputOptions([
        '-map 0',
        '-c copy',
        '-f segment',
        `-segment_time ${SEGMENT_DURATION_SECONDS}`,
        '-reset_timestamps 1'
      ])
      .output(outputPattern)
  );

  const files = await fsp.readdir(segmentsDir);
  return files
    .filter((file) => file.endsWith('.mp4'))
    .sort()
    .map((file) => path.join(segmentsDir, file));
}

async function processSegmentToTs(segmentPath, processedTsPath) {
  await runFfmpeg(
    ffmpeg(segmentPath)
      .outputOptions([
        '-map 0:v:0',
        '-map 0:a?',
        '-c:v libx264',
        `-preset ${EXPORT_PRESET}`,
        `-crf ${EXPORT_CRF}`,
        '-pix_fmt yuv420p',
        '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
        `-r ${EXPORT_FPS}`,
        '-c:a aac',
        '-b:a 192k',
        '-ar 48000',
        '-ac 2',
        '-f mpegts'
      ])
      .output(processedTsPath)
  );
}

async function appendFile(sourcePath, destinationPath) {
  await new Promise((resolve, reject) => {
    const read = fs.createReadStream(sourcePath);
    const write = fs.createWriteStream(destinationPath, { flags: 'a' });

    read.on('error', reject);
    write.on('error', reject);
    write.on('finish', resolve);

    read.pipe(write);
  });
}

async function remuxTsToMp4(inputTsPath, outputMp4Path) {
  await runFfmpeg(
    ffmpeg(inputTsPath)
      .outputOptions([
        '-c copy',
        '-bsf:a aac_adtstoasc',
        '-movflags +faststart'
      ])
      .output(outputMp4Path)
  );
}

function scheduleFinalCleanup(jobDir) {
  setTimeout(async () => {
    console.log('Nettoyage automatique:', jobDir);
    await safeRemove(jobDir);
  }, FINAL_FILE_TTL_MS);
}

app.get('/', (req, res) => {
  res.type('html').send(`
<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Montage Render Segments</title>
  <style>
    body { font-family: Arial, sans-serif; background:#0f172a; color:white; padding:24px; max-width:720px; margin:auto; }
    .box { background:#111827; border:1px solid #334155; border-radius:16px; padding:20px; margin-top:20px; }
    input,button { width:100%; padding:14px; margin-top:12px; border-radius:12px; border:0; font-size:16px; }
    button { background:#2563eb; color:white; font-weight:700; }
    button:disabled { opacity:.55; }
    a { color:#38bdf8; font-weight:700; }
    pre { white-space:pre-wrap; background:#020617; padding:12px; border-radius:12px; overflow:auto; }
  </style>
</head>
<body>
  <h1>Montage Render par segments</h1>
  <div class="box">
    <p>Upload une vidéo. Le serveur découpe en segments, traite un segment à la fois, puis exporte un MP4 final.</p>
    <form id="form">
      <input type="file" name="video" accept="video/*" required />
      <button id="btn" type="submit">Créer le MP4 final</button>
    </form>
    <div id="result"></div>
  </div>
  <script>
    const form = document.getElementById('form');
    const btn = document.getElementById('btn');
    const result = document.getElementById('result');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const file = form.querySelector('input[type=file]').files[0];
      if (!file) return;
      if (file.size > ${MAX_UPLOAD_BYTES}) {
        result.innerHTML = '<p>Fichier trop lourd. Limite actuelle : ${MAX_UPLOAD_MB} Mo.</p>';
        return;
      }
      const data = new FormData();
      data.append('video', file);
      btn.disabled = true;
      btn.textContent = 'Traitement en cours...';
      result.innerHTML = '<p>Découpage et traitement par segments. Ne ferme pas la page.</p>';
      try {
        const response = await fetch('/api/process-video', { method: 'POST', body: data });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || 'Erreur inconnue');
        result.innerHTML = '<h3>MP4 généré</h3><p><a href="' + json.downloadUrl + '" download>Télécharger la vidéo finale</a></p><pre>' + JSON.stringify(json, null, 2) + '</pre>';
      } catch (error) {
        result.innerHTML = '<p>Erreur : ' + error.message + '</p>';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Créer le MP4 final';
      }
    });
  </script>
</body>
</html>
  `);
});

app.get('/api/health', async (req, res) => {
  const tmpSize = await getFolderSizeBytes(TMP_ROOT);
  res.json({
    ok: true,
    service: 'montage-render-segments',
    tmpSizeMb: Math.round(tmpSize / 1024 / 1024),
    segmentDurationSeconds: SEGMENT_DURATION_SECONDS,
    maxUploadMb: MAX_UPLOAD_MB,
    maxSegments: MAX_SEGMENTS,
    export: {
      preset: EXPORT_PRESET,
      crf: EXPORT_CRF,
      fps: EXPORT_FPS
    }
  });
});

app.post('/api/process-video', upload.single('video'), async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(JOBS_DIR, jobId);
  const segmentsDir = path.join(jobDir, 'segments');
  const processedDir = path.join(jobDir, 'processed');

  let inputPath = req.file?.path;

  try {
    if (!req.file || !inputPath) {
      return res.status(400).json({ success: false, error: 'Aucune vidéo reçue.' });
    }

    await ensureDir(jobDir);
    await ensureDir(segmentsDir);
    await ensureDir(processedDir);

    const originalInfo = await getVideoInfo(inputPath);
    if (!originalInfo.duration || originalInfo.duration <= 0) {
      throw new Error('Impossible de lire la durée de la vidéo.');
    }

    const estimatedSegments = Math.ceil(originalInfo.duration / SEGMENT_DURATION_SECONDS);
    if (estimatedSegments > MAX_SEGMENTS) {
      throw new Error(`Vidéo trop longue pour Render Free. Limite actuelle : ${MAX_SEGMENTS} segments de ${SEGMENT_DURATION_SECONDS}s.`);
    }

    const finalTsPath = path.join(jobDir, 'final_stream.ts');
    const finalMp4Path = path.join(jobDir, 'final.mp4');

    const segments = await splitIntoSegments(inputPath, segmentsDir);

    await safeRemove(inputPath);
    inputPath = null;

    for (let index = 0; index < segments.length; index++) {
      const segmentPath = segments[index];
      const processedTsPath = path.join(processedDir, `processed_${String(index + 1).padStart(3, '0')}.ts`);

      console.log(`Segment ${index + 1}/${segments.length}`);
      await processSegmentToTs(segmentPath, processedTsPath);
      await appendFile(processedTsPath, finalTsPath);

      await safeRemove(segmentPath);
      await safeRemove(processedTsPath);
    }

    await safeRemove(segmentsDir);
    await safeRemove(processedDir);

    await remuxTsToMp4(finalTsPath, finalMp4Path);
    await safeRemove(finalTsPath);

    const finalInfo = await getVideoInfo(finalMp4Path);
    const tmpSize = await getFolderSizeBytes(TMP_ROOT);

    scheduleFinalCleanup(jobDir);

    res.json({
      success: true,
      jobId,
      message: 'Vidéo traitée par segments avec succès.',
      input: {
        durationSeconds: Math.round(originalInfo.duration),
        sizeMb: Math.round(originalInfo.size / 1024 / 1024),
        width: originalInfo.width,
        height: originalInfo.height,
        videoCodec: originalInfo.videoCodec,
        audioCodec: originalInfo.audioCodec
      },
      output: {
        durationSeconds: Math.round(finalInfo.duration),
        sizeMb: Math.round((finalInfo.size || 0) / 1024 / 1024),
        width: finalInfo.width,
        height: finalInfo.height,
        videoCodec: finalInfo.videoCodec,
        audioCodec: finalInfo.audioCodec
      },
      renderProtection: {
        segments: segments.length,
        segmentDurationSeconds: SEGMENT_DURATION_SECONDS,
        tmpSizeMb: Math.round(tmpSize / 1024 / 1024),
        cleanup: 'Le fichier final sera supprimé automatiquement.'
      },
      downloadUrl: `/downloads/${jobId}/final.mp4`
    });
  } catch (error) {
    console.error('Erreur traitement vidéo:', error);
    await safeRemove(inputPath);
    await safeRemove(jobDir);
    res.status(500).json({ success: false, error: error.message || 'Erreur pendant le traitement vidéo.' });
  }
});

app.use((error, req, res, next) => {
  console.error('Erreur globale:', error);
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: `Fichier trop lourd. Limite actuelle : ${MAX_UPLOAD_MB} Mo.` });
  }
  res.status(500).json({ success: false, error: error.message || 'Erreur serveur.' });
});

async function boot() {
  await ensureDir(TMP_ROOT);
  await ensureDir(UPLOAD_DIR);
  await ensureDir(JOBS_DIR);
  app.listen(PORT, () => {
    console.log(`Serveur lancé sur le port ${PORT}`);
    console.log(`Upload max: ${MAX_UPLOAD_MB} Mo`);
    console.log(`Segments: ${SEGMENT_DURATION_SECONDS} secondes`);
  });
}

boot();
