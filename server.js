const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

const TMP = path.join(__dirname, 'tmp');
const UPLOADS = path.join(TMP, 'uploads');
const JOBS = path.join(TMP, 'jobs');

const MAX_VIDEO_SECONDS = Number(process.env.MAX_VIDEO_SECONDS || 180);
const SEGMENT_SECONDS = Number(process.env.SEGMENT_DURATION_SECONDS || 10);
const MAX_SEGMENTS = Number(process.env.MAX_SEGMENTS || 18);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 150);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const CLEANUP_MS = 60 * 60 * 1000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/downloads', express.static(JOBS));

async function mkdir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function rm(target) {
  if (!target) return;
  try { await fsp.rm(target, { recursive: true, force: true }); } catch {}
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    cmd.on('end', resolve).on('error', reject).run();
  });
}

function probe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, meta) => {
      if (err) return reject(err);
      const video = meta.streams.find(s => s.codec_type === 'video');
      const audio = meta.streams.find(s => s.codec_type === 'audio');
      resolve({
        duration: Number(meta.format.duration || 0),
        size: Number(meta.format.size || 0),
        width: video?.width || null,
        height: video?.height || null,
        videoCodec: video?.codec_name || null,
        audioCodec: audio?.codec_name || null
      });
    });
  });
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

async function split(input, outDir) {
  await mkdir(outDir);
  await run(
    ffmpeg(input)
      .outputOptions([
        '-map 0',
        '-c copy',
        '-f segment',
        `-segment_time ${SEGMENT_SECONDS}`,
        '-reset_timestamps 1'
      ])
      .output(path.join(outDir, 'segment_%03d.mp4'))
  );
  const files = await fsp.readdir(outDir);
  return files.filter(f => f.endsWith('.mp4')).sort().map(f => path.join(outDir, f));
}

async function processSegment(input, output) {
  await run(
    ffmpeg(input)
      .outputOptions([
        '-map 0:v:0',
        '-map 0:a?',
        '-c:v libx264',
        '-preset veryfast',
        '-crf 18',
        '-pix_fmt yuv420p',
        '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-r 30',
        '-c:a aac',
        '-b:a 192k',
        '-ar 48000',
        '-ac 2',
        '-f mpegts'
      ])
      .output(output)
  );
}

function append(source, target) {
  return new Promise((resolve, reject) => {
    const read = fs.createReadStream(source);
    const write = fs.createWriteStream(target, { flags: 'a' });
    read.on('error', reject);
    write.on('error', reject);
    write.on('finish', resolve);
    read.pipe(write);
  });
}

async function finalMp4(inputTs, outputMp4) {
  await run(
    ffmpeg(inputTs)
      .outputOptions(['-c copy', '-bsf:a aac_adtstoasc', '-movflags +faststart'])
      .output(outputMp4)
  );
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'Studio Video IA backend actif',
    maxVideoSeconds: MAX_VIDEO_SECONDS,
    segmentSeconds: SEGMENT_SECONDS,
    maxSegments: MAX_SEGMENTS
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'studio-video-ia-segments',
    maxVideoSeconds: MAX_VIDEO_SECONDS,
    segmentSeconds: SEGMENT_SECONDS,
    maxSegments: MAX_SEGMENTS,
    maxUploadMb: MAX_UPLOAD_MB
  });
});

app.post('/api/process-video', upload.single('video'), async (req, res) => {
  const jobId = uuid();
  const jobDir = path.join(JOBS, jobId);
  const segmentsDir = path.join(jobDir, 'segments');
  const processedDir = path.join(jobDir, 'processed');
  let input = req.file?.path;

  try {
    if (!input) return res.status(400).json({ success: false, error: 'Aucune vidéo reçue.' });

    await mkdir(jobDir);
    await mkdir(segmentsDir);
    await mkdir(processedDir);

    const info = await probe(input);
    if (!info.duration) throw new Error('Impossible de lire la durée de la vidéo.');
    if (info.duration > MAX_VIDEO_SECONDS) throw new Error('Vidéo trop longue. Maximum autorisé : 3 minutes.');

    const segments = await split(input, segmentsDir);
    await rm(input);
    input = null;

    if (segments.length > MAX_SEGMENTS) throw new Error(`Trop de segments. Maximum autorisé : ${MAX_SEGMENTS}.`);

    const streamTs = path.join(jobDir, 'final.ts');
    const outputMp4 = path.join(jobDir, 'final.mp4');

    for (let i = 0; i < segments.length; i++) {
      const ts = path.join(processedDir, `processed_${String(i + 1).padStart(3, '0')}.ts`);
      await processSegment(segments[i], ts);
      await append(ts, streamTs);
      await rm(segments[i]);
      await rm(ts);
    }

    await rm(segmentsDir);
    await rm(processedDir);
    await finalMp4(streamTs, outputMp4);
    await rm(streamTs);

    const outInfo = await probe(outputMp4);
    setTimeout(() => rm(jobDir), CLEANUP_MS);

    res.json({
      success: true,
      message: 'MP4 généré par segments.',
      jobId,
      segments: segments.length,
      segmentSeconds: SEGMENT_SECONDS,
      maxVideoSeconds: MAX_VIDEO_SECONDS,
      input: {
        durationSeconds: Math.round(info.duration),
        sizeMb: Math.round(info.size / 1024 / 1024),
        width: info.width,
        height: info.height
      },
      output: {
        durationSeconds: Math.round(outInfo.duration),
        sizeMb: Math.round(outInfo.size / 1024 / 1024),
        width: outInfo.width,
        height: outInfo.height
      },
      downloadUrl: `/downloads/${jobId}/final.mp4`
    });
  } catch (error) {
    await rm(input);
    await rm(jobDir);
    res.status(500).json({ success: false, error: error.message || 'Erreur traitement vidéo.' });
  }
});

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: `Fichier trop lourd. Maximum : ${MAX_UPLOAD_MB} Mo.` });
  }
  res.status(500).json({ success: false, error: err.message || 'Erreur serveur.' });
});

async function boot() {
  await mkdir(TMP);
  await mkdir(UPLOADS);
  await mkdir(JOBS);
  app.listen(PORT, () => console.log(`Backend actif sur port ${PORT}`));
}

boot();
