//Xeno Exe
const axios = require('axios')
const yts = require('yt-search')
const config = require('../config')
const { cmd } = require('../command')

const QUALITY_API = 'https://yt-quality-api.vercel.app/api/ytmp4?url='
const MAX_MB = config.DL_MAX_MB || 80
const MAX_BYTES = MAX_MB * 1024 * 1024
const MAX_MINUTES = config.DL_MAX_MINUTES || 20
const LIST_TTL_MS = 10 * 60 * 1000
const REQUEST_COOLDOWN_MS = 5000

const pending = new Map()
const lastRequest = new Map()

setInterval(() => {
    const now = Date.now()
    for (const [id, p] of pending) if (p.expires < now) pending.delete(id)
}, 60 * 1000).unref()

const YT_ID_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^\s&]*&)*v=|shorts\/|live\/|embed\/|v\/))([A-Za-z0-9_-]{11})/i

const react = (conn, from, mek, text) => conn.sendMessage(from, { react: { text, key: mek.key } }).catch(() => {})

function sizeOf(url) {
    try {
        const n = Number(new URL(url).searchParams.get('clen'))
        return n > 0 ? n : 0
    } catch (e) { return 0 }
}

const fmtMB = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB'
const fmtTime = (s) => {
    s = Math.round(Number(s) || 0)
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0')
}

const height = (q) => Number(String(q).replace(/\D/g, '')) || 0

function cleanDownloads(list) {
    const seen = new Set()
    return (Array.isArray(list) ? list : [])
        .filter(d => d && /^https?:\/\//i.test(d.url || ''))
        .map(d => ({ quality: String(d.quality || 'Video').trim(), url: d.url }))
        .filter(d => !seen.has(d.quality) && seen.add(d.quality))
        .sort((a, b) => height(b.quality) - height(a.quality))
}

async function resolveUrl(input) {
    const id = (input.match(YT_ID_RE) || [])[1]
    if (id) return { url: `https://youtu.be/${id}`, thumb: '' }
    const video = (await yts(input)).videos?.[0]
    if (!video) throw new Error('NO_RESULT')
    if (video.seconds > MAX_MINUTES * 60) throw new Error('TOO_LONG')
    return { url: video.url, thumb: video.thumbnail || '' }
}

async function fetchQualities(videoUrl) {
    const { data } = await axios.get(QUALITY_API + encodeURIComponent(videoUrl), {
        timeout: 45000, headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    if (!data || data.status === false || !data.result) throw new Error('API_FAIL')
    const downloads = cleanDownloads(data.result.downloads)
    if (!downloads.length) throw new Error('API_FAIL')
    if (Number(data.result.duration) > MAX_MINUTES * 60) throw new Error('TOO_LONG')
    return {
        title: data.result.title || 'YouTube Video',
        author: data.result.author || '',
        duration: data.result.duration,
        thumbnail: data.result.thumbnail,
        downloads
    }
}

function friendly(e) {
    const m = String(e?.message || e)
    if (m === 'NO_RESULT') return 'No YouTube results found. Try another name or paste a link.'
    if (m === 'TOO_LONG') return `Video is longer than ${MAX_MINUTES} minutes.`
    if (m === 'API_FAIL') return 'Could not get download qualities for that video. Try again in a moment.'
    return 'Something went wrong. Please try again.'
}

cmd({
    pattern: "yt",
    alias: ["ytq", "ytquality"],
    desc: "Download a YouTube video in the quality you choose. Usage: /yt <link or name>",
    category: "download",
    react: "🎬",
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, sender, reply }) => {
    try {
        const input = (q || '').trim()
        if (!input) return reply(`Usage: ${prefix}yt <YouTube link or video name>\nExample: ${prefix}yt https://youtu.be/myvmueZ3NcI`)

        const wait = lastRequest.get(sender) + REQUEST_COOLDOWN_MS - Date.now()
        if (wait > 0) return reply(`⏳ Please wait ${Math.ceil(wait / 1000)}s before using ${prefix}yt again.`)
        lastRequest.set(sender, Date.now())

        await react(conn, from, mek, '⏳')
        const { url, thumb } = await resolveUrl(input)
        const info = await fetchQualities(url)

        const lines = info.downloads.map((d, i) => {
            const size = sizeOf(d.url)
            return `*${i + 1}.* ${d.quality}${size ? `  (${fmtMB(size)})` : ''}`
        })
        const caption =
            `*${info.title}*\n\n` +
            (info.author ? `࿇ ${info.author}\n` : '') +
            (info.duration ? `࿇ ${fmtTime(info.duration)}\n` : '') +
            `\n*Select a quality*\n${lines.join('\n')}\n\n` +
            `_Reply to this message with a number (1-${info.downloads.length})_`

        const image = /^https?:\/\//i.test(info.thumbnail || '') ? info.thumbnail : thumb
        const sent = image
            ? await conn.sendMessage(from, { image: { url: image }, caption }, { quoted: mek })
            : await conn.sendMessage(from, { text: caption }, { quoted: mek })

        pending.set(sent.key.id, {
            from, title: info.title, downloads: info.downloads,
            expires: Date.now() + LIST_TTL_MS, busy: false
        })
    } catch (e) {
        console.log('[YT-QUALITY]', e?.message || e)
        await react(conn, from, mek, '❌')
        reply(friendly(e))
    }
})


cmd({ on: 'body', dontAddCommandList: true, filename: __filename },
async (conn, mek, m, { from, body, isCmd, reply }) => {
    try {
        if (isCmd) return
        const choice = /^\s*(\d{1,2})\s*$/.exec(body || '')
        if (!choice) return

        const stanzaId = mek.message?.extendedTextMessage?.contextInfo?.stanzaId
        const entry = stanzaId && pending.get(stanzaId)
        if (!entry || entry.from !== from) return
        if (entry.expires < Date.now()) { pending.delete(stanzaId); return reply('⌛ That list expired. Send the yt command again.') }

        const n = Number(choice[1])
        const pick = entry.downloads[n - 1]
        if (!pick) return reply(`Reply with a number from 1 to ${entry.downloads.length}.`)
        if (entry.busy) return reply('⏳ Still downloading, please wait.')

        const size = sizeOf(pick.url)
        if (size > MAX_BYTES) return reply(`❌ ${pick.quality} is ${fmtMB(size)}, larger than the ${MAX_MB} MB limit. Pick a lower quality.`)

        entry.busy = true
        try {
            await react(conn, from, mek, '⏳')
            await conn.sendMessage(from, {
                video: { url: pick.url },
                mimetype: 'video/mp4',
                caption: `*${entry.title}*\n࿇ ${pick.quality}`
            }, { quoted: mek })
            await react(conn, from, mek, '✅')
        } finally {
            entry.busy = false
        }
    } catch (e) {
        console.log('[YT-QUALITY] download failed:', e?.message || e)
        await react(conn, from, mek, '❌')
        reply('_ERROR_')
    }
})

module.exports = { cleanDownloads, sizeOf, pending }
