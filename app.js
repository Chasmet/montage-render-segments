const backend = document.getElementById('backend');
const log = document.getElementById('log');
const info = document.getElementById('info');
const video = document.getElementById('video');
const resultBox = document.getElementById('resultBox');
const resultInfo = document.getElementById('resultInfo');
const downloadBtn = document.getElementById('downloadBtn');
const openBtn = document.getElementById('openBtn');
const preview = document.getElementById('preview');

backend.value = localStorage.getItem('backendUrl') || '';

function clean(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function write(message) {
  log.textContent = String(message);
}

function hideResult() {
  resultBox.classList.add('hidden');
  downloadBtn.href = '#';
  openBtn.href = '#';
  preview.removeAttribute('src');
  preview.load();
}

function showResult(link, json) {
  resultBox.classList.remove('hidden');
  downloadBtn.href = link;
  downloadBtn.setAttribute('download', 'video-traitee.mp4');
  openBtn.href = link;
  preview.src = link;

  const inputSize = json?.input?.sizeMb ?? '?';
  const outputSize = json?.output?.sizeMb ?? '?';
  resultInfo.textContent = `Vidéo prête. Taille originale : ${inputSize} Mo. MP4 final : ${outputSize} Mo.`;

  resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function saveBackend() {
  const url = clean(backend.value);
  localStorage.setItem('backendUrl', url);
  write('URL sauvegardée : ' + url);
}

function fileInfo() {
  hideResult();
  const file = video.files[0];
  if (!file) {
    info.textContent = 'Aucune vidéo choisie.';
    return;
  }
  const mb = Math.round(file.size / 1024 / 1024);
  info.textContent = file.name + ' - ' + mb + ' Mo';
  if (mb > 30) write('Attention : sur Render gratuit, le maximum conseillé est 30 Mo.');
}

async function testBackend() {
  const url = clean(backend.value);
  if (!url) return write('Ajoute l’URL Render.');
  try {
    const response = await fetch(url + '/api/health');
    const json = await response.json();
    write('Serveur OK :\n' + JSON.stringify(json, null, 2));
  } catch (error) {
    write('Serveur non joignable : ' + error.message);
  }
}

async function sendVideo() {
  hideResult();

  const url = clean(backend.value);
  const file = video.files[0];

  if (!url) return write('Ajoute l’URL Render.');
  if (!file) return write('Choisis une vidéo.');

  const mb = Math.round(file.size / 1024 / 1024);
  if (mb > 30) {
    write('Vidéo lourde : ' + mb + ' Mo. Sur Render gratuit, teste plutôt une vidéo de moins de 30 Mo.');
  }

  const data = new FormData();
  data.append('video', file);

  write('Upload vers Render en cours. Ne ferme pas la page pendant le traitement.');

  try {
    const response = await fetch(url + '/api/process-video', {
      method: 'POST',
      body: data
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(text || 'Réponse serveur illisible.');
    }

    if (!response.ok) throw new Error(json.error || 'Erreur serveur ' + response.status);

    const link = url + json.downloadUrl;
    showResult(link, json);
    write('MP4 prêt. Utilise le bouton bleu “Télécharger le MP4”.\n\n' + link + '\n\n' + JSON.stringify(json, null, 2));
  } catch (error) {
    write('Erreur upload ou traitement : ' + error.message + '\n\nRegarde les logs Render juste après l’erreur.');
  }
}
