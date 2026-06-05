const backend = document.getElementById('backend');
const log = document.getElementById('log');
const info = document.getElementById('info');
const video = document.getElementById('video');

backend.value = localStorage.getItem('backendUrl') || '';

function clean(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function write(message) {
  log.textContent = String(message);
}

function saveBackend() {
  const url = clean(backend.value);
  localStorage.setItem('backendUrl', url);
  write('URL sauvegardée : ' + url);
}

function fileInfo() {
  const file = video.files[0];
  if (!file) {
    info.textContent = 'Aucune vidéo choisie.';
    return;
  }
  const mb = Math.round(file.size / 1024 / 1024);
  info.textContent = file.name + ' - ' + mb + ' Mo';
  if (mb > 150) write('Vidéo trop lourde. Maximum autorisé : 150 Mo.');
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
  const url = clean(backend.value);
  const file = video.files[0];

  if (!url) return write('Ajoute l’URL Render.');
  if (!file) return write('Choisis une vidéo.');

  const mb = Math.round(file.size / 1024 / 1024);
  if (mb > 150) return write('Vidéo trop lourde : ' + mb + ' Mo. Maximum autorisé : 150 Mo.');

  const data = new FormData();
  data.append('video', file);

  write('Upload vers Render en cours. Pour le premier test, utilise une vidéo de 10 à 20 secondes.');

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
    write('MP4 prêt : ' + link + '\n\n' + JSON.stringify(json, null, 2));
  } catch (error) {
    write('Erreur upload ou traitement : ' + error.message + '\n\nRegarde les logs Render juste après l’erreur.');
  }
}
