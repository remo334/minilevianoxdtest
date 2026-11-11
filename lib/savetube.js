// Savetube.vip API client (reverse-engineered public endpoint, same one
// that powers https://yt.savetube.me). Used as a fallback downloader when
// the primary ytvideo2 / ytmp4dl APIs are down or rate-limited.
//
// Flow:
//   1. GET  https://media.savetube.vip/api/random-cdn      -> pick a CDN host
//   2. POST https://<cdn>/v2/info   { url }                -> AES-encrypted blob
//      decrypt it (AES-128-CBC, fixed key) to get { key, title, thumbnail, ... }
//   3. POST https://<cdn>/download  { id, downloadType, quality, key }
//      -> { data: { downloadUrl } }  (this is the cdn40x.savetube.vip/media/... link)

const axios = require('axios')
const crypto = require('crypto')

const AES_KEY = Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex')
const VIDEO_QUALITIES = ['144', '240', '360', '480', '720', '1080']
const AUDIO_QUALITIES = ['mp3']

const YT_ID_RE = /^((?:https?:)?\/\/)?((?:www|m|music)\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=)?(?:embed\/)?(?:v\/)?(?:shorts\/)?([a-zA-Z0-9_-]{11})/

const client = axios.create({
    timeout: 60000,
    headers: {
        'content-type': 'application/json',
        'origin': 'https://yt.savetube.me',
        'user-agent': 'Mozilla/5.0 (Android 15; Mobile; SM-F958; rv:130.0) Gecko/130.0 Firefox/130.0'
    }
})

function extractId(url) {
    return (String(url).match(YT_ID_RE) || [])[3] || null
}

function decrypt(enc) {
    const raw = Buffer.from(enc, 'base64')
    const iv = raw.subarray(0, 16)
    const data = raw.subarray(16)
    const decipher = crypto.createDecipheriv('aes-128-cbc', AES_KEY, iv)
    const out = Buffer.concat([decipher.update(data), decipher.final()])
    return JSON.parse(out.toString('utf8'))
}

async function getCdn() {
    const { data } = await client.get('https://media.savetube.vip/api/random-cdn')
    if (!data?.cdn) throw new Error('SAVETUBE_NO_CDN')
    return data.cdn
}

// quality: '144'..'1080' for video, 'mp3' for audio
async function savetubeDownload(youtubeUrl, quality = '720') {
    const id = extractId(youtubeUrl)
    if (!id) throw new Error('SAVETUBE_BAD_URL')

    const isAudio = quality === 'mp3'
    if (!(isAudio ? AUDIO_QUALITIES : VIDEO_QUALITIES).includes(quality)) {
        throw new Error('SAVETUBE_BAD_QUALITY')
    }

    const cdn = await getCdn()

    const infoRes = await client.post(`https://${cdn}/v2/info`, {
        url: `https://www.youtube.com/watch?v=${id}`
    })
    const info = decrypt(infoRes.data?.data)
    if (!info?.key) throw new Error('SAVETUBE_NO_KEY')

    const dlRes = await client.post(`https://${cdn}/download`, {
        id,
        downloadType: isAudio ? 'audio' : 'video',
        quality: isAudio ? '128' : quality,
        key: info.key
    })
    const downloadUrl = dlRes.data?.data?.downloadUrl
    if (!downloadUrl) throw new Error('SAVETUBE_NO_LINK')

    return {
        url: downloadUrl,
        title: info.title,
        thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        duration: info.duration
    }
}

module.exports = { savetubeDownload, extractId }
