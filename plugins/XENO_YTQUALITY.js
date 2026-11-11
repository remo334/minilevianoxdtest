//Xeno Exe
// YouTube video downloader with quality menu (reply 1 = 360p, 2 = 720p, 3 = 1080p)
// Uses ONLY these two APIs (no yt-dlp, no ytdl-core, no other servers):
//   1) https://xenosirapis.zone.id/api/ytvideo2?url=...&quality=...
//   2) https://xenosirapis.zone.id/api/ytmp4dl?url=...&quality=...
const axios = require('axios')
const yts = require('yt-search')
const { cmd } = require('../command')

const YTVIDEO2_API = 'https://xenosirapis.zone.id/api/ytvideo2?url='
const YTMP4DL_API = 'https://xenosirapis.zone.id/api/ytmp4dl?url='
const QUALITIES = ['1080', '720', '360']          // reply 1 = 1080p, 2 = 720p, 3 = 360p
const DOC_LIMIT = 100 * 1024 * 1024               // above 100 MB -> send as document
const LIST_TTL_MS = 10 * 60 * 1000
const REQUEST_COOLDOWN_MS = 5000
const UA = { 'User-Agent': 'Mozilla/5.0' }

const pending = new Map()
const lastRequest = new Map()

setInterval(() => {
    const now = Date.now()
    for (const [id, p] of pending) if (p.expires < now) pending.delete(id)
}, 60 * 1000).unref()

const YT_ID_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^\s&]*&)*v=|shorts\/|live\/|embed\/|v\/))([A-Za-z0-9_-]{11})/i

const react = (conn, from, mek, text) => conn.sendMessage(from, { react: { text, key: mek.key } }).catch(() => {})
const fmtMB = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB'

// 1) search / resolve the video link first
async function resolveVideo(input) {
    const id = (input.match(YT_ID_RE) || [])[1]
    const video = id ? await yts({ videoId: id }) : (await yts(input)).videos?.[0]
    if (!video) throw new Error('NO_RESULT')
    return {
        url: `https://youtu.be/${video.videoId || id}`,
        title: video.title || 'YouTube Video',
        author: video.author?.name || '',
        duration: video.timestamp || '',
        thumbnail: video.thumbnail || video.image || ''
    }
}

// find a direct media link inside any API response shape
function findLink(obj) {
    const preferred = ['downloadUrl', 'download_url', 'download', 'dl', 'link', 'url', 'src']
    const seen = new Set()
    const walk = (o, depth = 0) => {
        if (o == null || depth > 5) return null
        if (typeof o === 'string') return (/^https?:\/\//i.test(o) && !/(youtu\.be|youtube\.com)\//i.test(o)) ? o : null
        if (typeof o !== 'object' || seen.has(o)) return null
        seen.add(o)
        for (const k of preferred) if (k in o) { const r = walk(o[k], depth + 1); if (r) return r }
        for (const k of Object.keys(o)) { const r = walk(o[k], depth + 1); if (r) return r }
        return null
    }
    return walk(obj)
}

// 2) ask the two APIs (ytvideo2 first, ytmp4dl as fallback)
async function getDownloadLink(videoUrl, quality) {
    let last
    for (const api of [YTVIDEO2_API, YTMP4DL_API]) {
        try {
            const { data } = await axios.get(`${api}${encodeURIComponent(videoUrl)}&quality=${quality}`, { timeout: 600000, headers: UA })
            if (data?.status === false || data?.success === false) throw new Error('API_FAIL')
            const link = findLink(data)
            if (!link) throw new Error('API_FAIL')
            return link
        } catch (e) {
            console.log('[YT-QUALITY]', api.split('/').pop(), 'failed:', e?.message || e)
            last = e
        }
    }
    throw last || new Error('API_FAIL')
}

// size of the remote file without downloading it
async function remoteSize(link) {
    try {
        const r = await axios.head(link, { timeout: 20000, headers: UA, maxRedirects: 5 })
        const n = Number(r.headers['content-length'])
        if (n > 0) return n
    } catch (e) { }
    try {
        const r = await axios.get(link, { responseType: 'stream', timeout: 20000, headers: UA, maxRedirects: 5 })
        const n = Number(r.headers['content-length'])
        r.data.destroy()
        if (n > 0) return n
    } catch (e) { }
    return 0
}

function friendly(e) {
    const m = String(e?.message || e)
    if (m === 'NO_RESULT') return 'No YouTube results found. Try another name or paste a link.'
    if (m === 'API_FAIL') return 'Could not download that video right now. Try another quality or try again later.'
    return 'Something went wrong. Please try again.'
}

cmd({
    pattern: "ytv",
    alias: ["yt", "ytq", "ytquality", "video", "ytmp4", "ytvideo", "ytdl"],
    desc: "Download a YouTube video in the quality you choose. Usage: /ytv <link or name>",
    category: "download",
    react: "🎬",
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, sender, reply }) => {
    try {
        const input = (q || '').trim()
        if (!input) return reply(`Usage: ${prefix}ytv <YouTube link or video name>\nExample: ${prefix}ytv https://youtu.be/myvmueZ3NcI`)

        const wait = lastRequest.get(sender) + REQUEST_COOLDOWN_MS - Date.now()
        if (wait > 0) return reply(`⏳ Please wait ${Math.ceil(wait / 1000)}s before using ${prefix}ytv again.`)
        lastRequest.set(sender, Date.now())

        await react(conn, from, mek, '⏳')
        const v = await resolveVideo(input)

        const caption =
            `*${v.title}*\n\n` +
            (v.author ? `࿇ ${v.author}\n` : '') +
            (v.duration ? `࿇ ${v.duration}\n` : '') +
            `࿇ ${v.url}\n\n` +
            `*Select a quality*\n` +
            QUALITIES.map((qt, i) => `*${i + 1}.* ${qt}p`).join('\n') +
            `\n\n_Reply to this message with 1, 2 or 3_\n_Please wait, big videos take more time to download_\n_Videos over 100 MB are sent as a document (mp4)_`

        const sent = /^https?:\/\//i.test(v.thumbnail)
            ? await conn.sendMessage(from, { image: { url: v.thumbnail }, caption }, { quoted: mek })
            : await conn.sendMessage(from, { text: caption }, { quoted: mek })

        pending.set(sent.key.id, { from, video: v, expires: Date.now() + LIST_TTL_MS, busy: false })
    } catch (e) {
        console.log('[YT-QUALITY]', e?.message || e)
        await react(conn, from, mek, '❌')
        reply(friendly(e))
    }
})

// reply "1" / "2" / "3" to the quality list
cmd({ on: 'body', dontAddCommandList: true, filename: __filename },
async (conn, mek, m, { from, body, isCmd, reply }) => {
    try {
        if (isCmd) return
        const choice = /^\s*([1-3])\s*$/.exec(body || '')
        if (!choice) return

        const stanzaId = mek.message?.extendedTextMessage?.contextInfo?.stanzaId
        const entry = stanzaId && pending.get(stanzaId)
        if (!entry || entry.from !== from) return
        if (entry.expires < Date.now()) { pending.delete(stanzaId); return reply('⌛ That list expired. Send the ytv command again.') }
        if (entry.busy) return reply('⏳ Still downloading, please wait.')

        const quality = QUALITIES[Number(choice[1]) - 1]
        const v = entry.video

        entry.busy = true
        try {
            await react(conn, from, mek, '⏳')
            const link = await getDownloadLink(v.url, quality)
            const size = await remoteSize(link)
            const caption = `*${v.title}*\n࿇ ${quality}p${size ? ` • ${fmtMB(size)}` : ''}`

            if (size > DOC_LIMIT) {
                const fileName = `${v.title.replace(/[\\/:*?"<>|]/g, '').trim() || 'video'} (${quality}p).mp4`
                await conn.sendMessage(from, { document: { url: link }, mimetype: 'video/mp4', fileName, caption }, { quoted: mek })
            } else {
                await conn.sendMessage(from, { video: { url: link }, mimetype: 'video/mp4', caption }, { quoted: mek })
            }
            await react(conn, from, mek, '✅')
        } finally {
            entry.busy = false
        }
    } catch (e) {
        console.log('[YT-QUALITY] download failed:', e?.message || e)
        await react(conn, from, mek, '❌')
        reply(friendly(e))
    }
})

module.exports = { pending }
