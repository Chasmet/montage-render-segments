# Montage Render Segments

Backend Render Free pour traiter une vidéo sans exploser le stockage.

## Principe

L'application fonctionne comme ça :

1. Upload vidéo
2. Analyse avec FFmpeg
3. Découpage en segments de 10 secondes
4. Traitement d'un segment à la fois
5. Suppression immédiate du segment original et du segment traité
6. Construction progressive du flux final
7. Export MP4 final
8. Téléchargement
9. Nettoyage automatique

## Pourquoi c'est adapté à Render Free

Render Free a peu de stockage disque. Cette méthode évite de garder toute la vidéo, tous les segments et tous les fichiers temporaires en même temps.

Réglages par défaut :

- Upload max : 150 Mo
- Segment : 10 secondes
- Limite : 60 segments, environ 10 minutes
- Export : MP4 H.264 + AAC
- Qualité : CRF 18
- FPS : 30
- Nettoyage final : automatique

## Déploiement Render

Sur Render :

- New Web Service
- Connecter ce dépôt GitHub
- Runtime : Node
- Build command : `npm install`
- Start command : `npm start`
- Plan : Free

Le fichier `render.yaml` est déjà présent pour faciliter le déploiement.

## Test

Une fois en ligne :

- Ouvre l'URL Render
- Upload une petite vidéo MP4 de test
- Clique sur créer le MP4 final
- Télécharge le résultat

## Endpoints

### Page de test

`GET /`

### Santé du serveur

`GET /api/health`

### Traitement vidéo

`POST /api/process-video`

FormData :

- `video` : fichier vidéo

## Variables possibles

Tu peux changer ces valeurs dans Render :

- `MAX_UPLOAD_MB` : limite upload en Mo
- `SEGMENT_DURATION_SECONDS` : durée des segments
- `MAX_SEGMENTS` : nombre maximum de segments
- `EXPORT_CRF` : qualité vidéo, plus bas = meilleure qualité mais fichier plus lourd
- `EXPORT_PRESET` : vitesse encodage FFmpeg
- `EXPORT_FPS` : FPS final

## Conseil Render Free

Pour éviter les crashs :

- tester d'abord avec moins de 50 Mo
- ne pas lancer plusieurs traitements en même temps
- garder des segments de 10 secondes
- éviter le 4K
- rester en 720p ou 1080p léger pour commencer
