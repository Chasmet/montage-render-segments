const backend = document.getElementById('backend');
const log = document.getElementById('log');
const info = document.getElementById('info');
const video = document.getElementById('video');
const scenario = document.getElementById('script');
const charactersBox = document.getElementById('charactersBox');
const characters = document.getElementById('characters');
const resultBox = document.getElementById('resultBox');
const resultInfo = document.getElementById('resultInfo');
const downloadBtn = document.getElementById('downloadBtn');
const openBtn = document.getElementById('openBtn');
const audioBtn = document.getElementById('audioBtn');
const preview = document.getElementById('preview');

const VOICES = [
  ['jeune-energie', 'Jeune énergique'],
  ['jeune-doux', 'Jeune doux'],
  ['feminin-doux', 'Féminin doux'],
  ['feminin-mystere', 'Féminin mystérieux'],
  ['homme-naturel', 'Homme naturel'],
  ['homme-grave', 'Homme grave'],
  ['mechant', 'Méchant'],
  ['robot', 'Robot'],
  ['monstre', 'Monstre'],
  ['urbain-melodique', 'Voix urbaine mélodique']
];

backend.value = localStorage.getItem('backendUrl') || '';
if (scenario) scenario.value = localStorage.getItem('scenarioText') || '';
let voiceMap = JSON.parse(localStorage.getItem('voiceMap') || '{}');

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
  if (audioBtn) {
    audioBtn.href = '#';
    audioBtn.classList.add('hidden');
  }
  preview.removeAttribute('src');
  preview.load();
}

function showResult(link, json, baseUrl) {
  resultBox.classList.remove('hidden');
  downloadBtn.href = link;
  downloadBtn.setAttribute('download', 'video-doublee.mp4');
  openBtn.href = link;
  preview.src = link;

  if (audioBtn && json.dubbing && json.dubbing.audioDownloadUrl) {
    audioBtn.classList.remove('hidden');
    audioBtn.href = baseUrl + json.dubbing.audioDownloadUrl;
    audioBtn.setAttribute('download', 'doublage.mp3');
  }

  const inputSize = json && json.input ? json.input.sizeMb : '?';
  const outputSize = json && json.output ? json.output.sizeMb : '?';
  const lines = json && json.dubbing ? json.dubbing.lines : 0;
  const timed = json && json.dubbing && json.dubbing.timed ? ' Oui' : ' Non';
  resultInfo.textContent = 'Vidéo prête. Original : ' + inputSize + ' Mo. MP4 final : ' + outputSize + ' Mo. Répliques : ' + lines + '. Timing calé :' + timed + '.';
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

function parseDialogueLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  const withoutTime = text.replace(/^\s*\[[^\]]+\]\s*/, '');
  const match = withoutTime.match(/^(.{1,40}?)\s*[:：∶﹕꞉;\-–—]\s*(.+)$/u);
  if (!match) return null;
  const name = match[1].trim();
  const dialogue = match[2].trim();
  if (!name || !dialogue) return null;
  return { name, dialogue };
}

function getNames() {
  const names = [];
  String(scenario ? scenario.value : '').split(/\r?\n/).forEach(line => {
    const parsed = parseDialogueLine(line);
    if (parsed && !names.includes(parsed.name)) names.push(parsed.name);
  });
  return names;
}

function detectCharacters() {
  if (!scenario) return;
  localStorage.setItem('scenarioText', scenario.value || '');
  const names = getNames();
  if (!names.length) {
    charactersBox.classList.add('hidden');
    write('Aucun personnage détecté. Écris par exemple : Yvane : Bonjour');
    return;
  }
  characters.innerHTML = '';
  names.forEach(name => {
    if (!voiceMap[name]) voiceMap[name] = 'homme-naturel';
    const card = document.createElement('div');
    card.className = 'character-card';
    const title = document.createElement('strong');
    title.textContent = name;
    const select = document.createElement('select');
    VOICES.forEach(v => {
      const option = document.createElement('option');
      option.value = v[0];
      option.textContent = v[1];
      if (voiceMap[name] === v[0]) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener('change', () => {
      voiceMap[name] = select.value;
      localStorage.setItem('voiceMap', JSON.stringify(voiceMap));
    });
    card.appendChild(title);
    card.appendChild(select);
    characters.appendChild(card);
  });
  localStorage.setItem('voiceMap', JSON.stringify(voiceMap));
  charactersBox.classList.remove('hidden');
  write(names.length + ' voix parlante(s) détectée(s). Corrige les voix si besoin.');
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

async function analyzeVideo() {
  hideResult();
  const url = clean(backend.value);
  const file = video.files[0];
  if (!url) return write('Ajoute l’URL Render.');
  if (!file) return write('Choisis une vidéo à analyser.');

  const data = new FormData();
  data.append('video', file);

  write('Analyse automatique en cours. OpenAI écoute la vidéo et détecte les voix parlantes. Ne ferme pas la page.');

  try {
    const response = await fetch(url + '/api/analyze-video', { method: 'POST', body: data });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(text || 'Réponse serveur illisible.');
    }
    if (!response.ok) throw new Error(json.error || 'Erreur serveur ' + response.status);

    if (scenario) {
      scenario.value = json.script || '';
      localStorage.setItem('scenarioText', scenario.value);
    }
    if (json.voiceMap) {
      voiceMap = json.voiceMap;
      localStorage.setItem('voiceMap', JSON.stringify(voiceMap));
    }
    detectCharacters();
    write('Analyse terminée. Les personnages silencieux sont ignorés. Vérifie les voix proposées puis clique sur “Générer la vidéo doublée MP4”.\n\n' + JSON.stringify(json, null, 2));
  } catch (error) {
    write('Erreur analyse vidéo : ' + error.message);
  }
}

async function sendVideo() {
  hideResult();
  if (scenario) localStorage.setItem('scenarioText', scenario.value || '');

  const url = clean(backend.value);
  const file = video.files[0];

  if (!url) return write('Ajoute l’URL Render.');
  if (!file) return write('Choisis une vidéo.');

  const names = getNames();
  if (scenario && scenario.value.trim() && !names.length) {
    return write('Le scénario n’est pas reconnu. Exemple : Yvane : Bonjour');
  }

  const data = new FormData();
  data.append('video', file);
  data.append('script', scenario ? scenario.value : '');
  data.append('voiceMap', JSON.stringify(voiceMap));

  write('Traitement en cours. Génération des voix puis création du MP4. Ne ferme pas la page.');

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
    showResult(link, json, url);
    write('MP4 prêt. Utilise le bouton vert “Télécharger le MP4”.\n\n' + link + '\n\n' + JSON.stringify(json, null, 2));
  } catch (error) {
    write('Erreur upload ou traitement : ' + error.message);
  }
}

if (scenario && scenario.value.trim()) detectCharacters();
