//Leviano Xd
const axios = require('axios')
const dns = require('dns').promises
const net = require('net')
const yts = require('yt-search')
const config = require('../config')
const { cmd } = require('../command')

const { ytdlpDownload } = require('../lib/ytdlp')
const { savetubeDownload } = require('../lib/savetube')

const MAX_MB = config.DL_MAX_MB || 500
const MAX_BYTES = MAX_MB * 1024 * 1024
const MAX_MINUTES = config.DL_MAX_MINUTES || 100
const COOLDOWN_MS = 8000
const lastUse = new Map()

const waitReact = (conn, from, mek) => conn.sendMessage(from, { react: { text: '⏳', key: mek.key } }).catch(() => {})


const customCaption = async (getSettings) => { try { return String((await getSettings()).caption || '').trim() } catch (e) { return '' } }

const waitTurn = async (id, conn, from, mek) => {
    const slot = Math.max(Date.now(), (lastUse.get(id) || 0) + COOLDOWN_MS)
    const delay = slot - Date.now()
    if (delay > 300000) return false
    lastUse.set(id, slot)
    if (delay > 0) {
        conn?.sendMessage(from, { react: { text: '⏳', key: mek.key } }).catch(() => {})
        await new Promise(r => setTimeout(r, delay))
    }
    return true
}

const cooldown = (id) => {
    const wait = lastUse.get(id) + COOLDOWN_MS - Date.now()
    if (wait > 0) return Math.ceil(wait / 1000)
    lastUse.set(id, Date.now())
    return 0
}

function isPrivateIp(ip) {
    if (net.isIPv6(ip)) {
        const v = ip.toLowerCase()
        if (v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true
        const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
        return mapped ? isPrivateIp(mapped[1]) : false
    }
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

async function assertPublic(u) {
    const url = new URL(u)
    if (!/^https?:$/.test(url.protocol)) throw new Error('BAD_URL')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true })
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('BLOCKED_URL')
    return url
}

async function fetchSafe(u, hops = 4) {
    let current = u
    for (let i = 0; i <= hops; i++) {
        await assertPublic(current)
        const res = await axios.get(current, {
            responseType: 'stream', maxRedirects: 0, timeout: 20000,
            validateStatus: s => s < 400, headers: { 'User-Agent': 'Mozilla/5.0' }
        })
        if (res.status >= 300 && res.headers.location) {
            res.data.destroy()
            current = new URL(res.headers.location, current).href
            continue
        }
        return { res, url: current }
    }
    throw new Error('TOO_MANY_REDIRECTS')
}

function toBuffer(stream, max = MAX_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        stream.on('data', c => {
            size += c.length
            if (size > max) { stream.destroy(); return reject(new Error('FILE_TOO_LARGE')) }
            chunks.push(c)
        })
        stream.on('end', () => resolve(Buffer.concat(chunks)))
        stream.on('error', reject)
    })
}

const SORRY = [
    '_SORRY, ERROR. TRY AGAIN_',
    '_OOPS, SOMETHING WENT WRONG. TRY AGAIN_',
    '_SORRY, COULD NOT DO THAT. PLEASE TRY AGAIN_',
    '_ERROR, PLEASE TRY AGAIN_'
]
const sorry = () => SORRY[Math.floor(Math.random() * SORRY.length)]
const friendly = (e) => {
    const m = String(e?.message || e)
    if (m === 'FILE_TOO_LARGE') return `File is larger than ${MAX_MB} MB.`
    if (m === 'BLOCKED_URL' || m === 'BAD_URL') return 'That link is not allowed.'
    if (m === 'TOO_LONG') return `Video is longer than ${MAX_MINUTES} minutes.`
    if (m === 'NO_RESULT') return 'No results found.'
    if (m === 'NO_MEDIA') return 'Could not find a video or photo in that post.'
    if (m === 'YT_BLOCKED') return 'YouTube is blocking this server right now. Add a cookies file (YTDLP_COOKIES) or try again later.'
    if (['YTDLP_FAILED', 'NO_YTDL', 'API_FAIL'].includes(m)) return 'Could not download that video right now. Try another link or try again later.'
    return sorry()
}

const YT_RE = /(youtu\.be\/|youtube\.com\/(watch|shorts|live))/i

const YT_ID_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^\s&]*&)*v=|shorts\/|live\/|embed\/))([A-Za-z0-9_-]{11})/i

async function resolveVideo(q) {
    let video
    const id = (String(q).match(YT_ID_RE) || [])[1]
    if (id) video = await yts({ videoId: id })
    else video = (await yts(q)).videos[0]
    if (!video) throw new Error('NO_RESULT')
    if (video.seconds > MAX_MINUTES * 60) throw new Error('TOO_LONG')
    return video
}

const card = (v) => `𝑳𝜺𝝂𝜾⃮⃯⃔𝜶𝜼𝝄♪🤍\n\n *${v.title}*\n\n࿇ ${v.author?.name || 'Unknown'}\n࿇ ${v.timestamp}\n࿇ ${Number(v.views || 0).toLocaleString()}\n࿇ ${v.url}`

const SEARCH_API = 'https://xenoytserch.vercel.app/api/ytsearch?q='
const MP3_API = 'https://xenoytdl-2.vercel.app/api/youtube?format=mp3&url='
const SONG_API = 'https://xenoytdl-2.vercel.app/api/youtube?url='

const toSeconds = (d) => String(d || '').split(':').reduce((a, b) => a * 60 + (Number(b) || 0), 0)

function findDownloadUrl(obj) {
    const preferred = ['download', 'downloadUrl', 'download_url', 'dl', 'link', 'audio', 'mp3', 'url', 'src']
    const seen = new Set()
    const walk = (o, depth = 0) => {
        if (o == null || depth > 5) return null
        if (typeof o === 'string') return (/^https?:\/\//i.test(o) && !YT_RE.test(o)) ? o : null
        if (typeof o !== 'object' || seen.has(o)) return null
        seen.add(o)
        for (const k of preferred) if (k in o) { const r = walk(o[k], depth + 1); if (r) return r }
        for (const k of Object.keys(o)) { const r = walk(o[k], depth + 1); if (r) return r }
        return null
    }
    return walk(obj)
}

async function searchSong(q) {
    const { data } = await axios.get(SEARCH_API + encodeURIComponent(q), { timeout: 30000 })
    const first = data?.results?.[0]
    if (!first || !first.url) throw new Error('NO_RESULT')
    return first
}

const YTVIDEO2_API = 'https://xenosirapis.zone.id/api/ytvideo2?url='
const AMEEN_YTD = 'https://ameen-api.vercel.app/v2/ytd?url='
const SIR_MP3 = 'https://xenosirapis.zone.id/api/ytmp3dl?url='
const SIR_MP4 = 'https://xenosirapis.zone.id/api/ytmp4dl?url='

async function downloadViaApi(api, videoUrl, expect, suffix = '') {
    const { data } = await axios.get(api + encodeURIComponent(videoUrl) + suffix, { timeout: 90000 })
    if (data?.status === false || data?.success === false) throw new Error('API_FAIL')
    const link = findDownloadUrl(data)
    if (!link) throw new Error('API_FAIL')
    const { res } = await fetchSafe(link)
    const type = String(res.headers['content-type'] || '')
    if (/text\/|html|json/i.test(type) || (expect === 'video' && /^audio\//i.test(type))) { res.data.destroy(); throw new Error('API_FAIL') }
    if (Number(res.headers['content-length']) > MAX_BYTES) { res.data.destroy(); throw new Error('FILE_TOO_LARGE') }
    return toBuffer(res.data)
}

function buildSongUrl(videoUrl) {
    return SONG_API + encodeURIComponent(videoUrl) + '&format=mp3'
}

async function downloadViaSongApi(videoUrl) {
    const { data } = await axios.get(buildSongUrl(videoUrl), { timeout: 90000 })
    if (data?.status === false || data?.success === false) throw new Error('API_FAIL')
    const link = findDownloadUrl(data)
    if (!link) throw new Error('API_FAIL')
    const { res } = await fetchSafe(link)
    const type = String(res.headers['content-type'] || '')
    if (/text\/|html|json/i.test(type)) { res.data.destroy(); throw new Error('API_FAIL') }
    if (Number(res.headers['content-length']) > MAX_BYTES) { res.data.destroy(); throw new Error('FILE_TOO_LARGE') }
    return toBuffer(res.data)
}

async function downloadViaSavetube(videoUrl, expect) {
    const result = await savetubeDownload(videoUrl, expect === 'audio' ? 'mp3' : '720')
    if (!result?.url) throw new Error('API_FAIL')
    const { res } = await fetchSafe(result.url)
    const type = String(res.headers['content-type'] || '')
    if (/text\/|html|json/i.test(type) || (expect === 'video' && /^audio\//i.test(type))) { res.data.destroy(); throw new Error('API_FAIL') }
    if (Number(res.headers['content-length']) > MAX_BYTES) { res.data.destroy(); throw new Error('FILE_TOO_LARGE') }
    return toBuffer(res.data)
}

async function firstThatWorks(label, steps) {
    let last
    for (const step of steps) {
        try { return await step() }
        catch (e) {
            if (e?.message === 'FILE_TOO_LARGE') throw e
            console.log(`[${label}] ${step.name || 'method'} failed:`, e?.message || e)
            if (!last || e?.message === 'YT_BLOCKED' || last?.message !== 'YT_BLOCKED') last = e
        }
    }
    throw last || new Error('API_FAIL')
}

const downloadMp3 = (videoUrl) => firstThatWorks('YT-AUDIO', [
    function songApi() { return downloadViaSongApi(videoUrl) },
    function ameenApi() { return downloadViaApi(AMEEN_YTD, videoUrl) },
    function sirApi() { return downloadViaApi(SIR_MP3, videoUrl) },
    function xenoApi() { return downloadViaApi(MP3_API, videoUrl) },
    function savetubeApi() { return downloadViaSavetube(videoUrl, 'audio') }
])

cmd({
    pattern: "play",
    alias: ["song", "ytmp3"],
    desc: "Download a song from YouTube. Usage: /play <name or link>",
    category: "download",
    react: "🎧",
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, sender, reply }) => {
    try {
        if (!q) return reply(`Usage: ${prefix}play <song name or YouTube link>`)
        if (!(await waitTurn(sender, conn, from, mek))) return

        await waitReact(conn, from, mek)
        const v = await searchSong(q.trim())
        if (toSeconds(v.duration) > MAX_MINUTES * 60) throw new Error('TOO_LONG')

        const caption = `*࿇${v.title}*\n\n࿇${v.channel || 'Unknown'}\n࿇ ${v.duration || '-'}\n࿇ ${v.views || '-'}\n࿇ ${v.url}\n\nDownloading audio…`
        if (v.thumbnail) await conn.sendMessage(from, { image: { url: v.thumbnail }, caption }, { quoted: mek })
        else await reply(caption)

        const audio = await downloadMp3(v.url)
        await conn.sendMessage(from, { audio, mimetype: 'audio/mpeg', fileName: `${v.title}.mp3` }, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})

// ---- yts uses @itsliaaa/starcore (only this command). Starcore re-exports its Baileys
// message builders, so the card is built with them and sent over the bot's own connection.
let _starcore
const loadStarcore = () => {
    if (_starcore !== undefined) return _starcore
    try { _starcore = require('@itsliaaa/starcore') }
    catch (e) { console.log('starcore not available:', e.message); _starcore = null }
    return _starcore
}

cmd({
    pattern: "yts",
    alias: ["ytsearch"],
    desc: "Search YouTube. Usage: /yts <query>",
    category: "download",
    react: "🔎",
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, reply }) => {
    try {
        if (!q) return reply(`Usage: ${prefix}yts <search words>`)
        const list = (await yts(q)).videos.slice(0, 8)
        if (!list.length) return reply('No results found.')

        // 1) Card carousel (starcore): one card per result, each with Copy link + Open buttons
        const sc = loadStarcore()
        if (sc && typeof sc.generateWAMessage === 'function') {
            try {
                const cards = list.filter(v => v.thumbnail || v.image).slice(0, 8).map(v => ({
                    image: { url: v.thumbnail || v.image },
                    caption: `*${String(v.title).slice(0, 90)}*\n⏱ ${v.timestamp || '-'}  •  👤 ${v.author?.name || '-'}\n👁 ${v.views ? v.views.toLocaleString() : '-'} views`,
                    footer: `${prefix}play <link> to download`,
                    nativeFlow: [
                        { text: '📋 Copy link', copy: v.url },
                        { text: '▶ Open', url: v.url }
                    ]
                }))
                if (cards.length) {
                    const msg = await sc.generateWAMessage(from, {
                        text: `*🔎 YouTube results for:* ${q}`,
                        footer: `${cards.length} results`,
                        cards
                    }, {
                        userJid: conn.user.id,
                        upload: conn.waUploadToServer,
                        quoted: mek,
                        messageId: undefined
                    })
                    const isGroup = from.endsWith('@g.us')
                    const biz = { tag: 'biz', attrs: {}, content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }] }
                    const additionalNodes = isGroup ? [biz] : [biz, { tag: 'bot', attrs: { biz_bot: '1' } }]
                    await conn.relayMessage(from, msg.message, { messageId: msg.key.id, additionalNodes })
                    return
                }
            } catch (err) {
                console.log('yts starcore card failed, using text:', err.message)
            }
        }

        // 2) Fallback: image + text list
        const text = `*🔎 YouTube results for:* ${q}\n\n` + list.map((v, i) =>
            `*${i + 1}. ${v.title}*\n⏱ ${v.timestamp || '-'}  •  👤 ${v.author?.name || '-'}\n🔗 ${v.url}`).join('\n\n') +
            `\n\n➤ Download audio: *${prefix}play <link>*`
        const thumb = list[0].thumbnail || list[0].image
        if (thumb) {
            try { return await conn.sendMessage(from, { image: { url: thumb }, caption: text }, { quoted: mek }) }
            catch (e) { console.log('yts thumbnail failed:', e.message) }
        }
        await conn.sendMessage(from, { text }, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})

cmd({
    pattern: "tiktok",
    alias: ["tt"],
    desc: "Download a TikTok video without watermark. Usage: /tiktok <link>",
    category: "download",
    react: "🎵",
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, sender, getSettings, reply }) => {
    try {
        const CUSTOM = await customCaption(getSettings)
        if (!/tiktok\.com/i.test(q || '')) return reply(`Usage: ${prefix}tiktok <TikTok link>`)
        if (!(await waitTurn(sender, conn, from, mek))) return
        await waitReact(conn, from, mek)
        const { data } = await axios.post('https://www.tikwm.com/api/', new URLSearchParams({ url: q.trim(), hd: '1' }), { timeout: 20000 })
        const d = data?.data
        const link = d?.hdplay || d?.play
        if (!link) throw new Error('NO_RESULT')
        const { res } = await fetchSafe(link)
        const video = await toBuffer(res.data)
        await conn.sendMessage(from, { video, mimetype: 'video/mp4', caption: CUSTOM || `*${d.title || 'TikTok video'}*\n${d.author?.nickname || ''}` }, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})

const IG_API = 'https://api-aswin-sparky.koyeb.app/api/downloader/igdl?url='
const IG_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+[^\s]*/i
const IG_MAX_ITEMS = 10

cmd({
    pattern: "insta",
    alias: ["ig", "igdl", "instagram", "reel"],
    desc: "Download Instagram reels, videos and photos. Usage: /insta <link>",
    category: "download",
    react: "📥",
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, quoted, sender, getSettings, reply }) => {
    try {
        const CUSTOM = await customCaption(getSettings)
        const quotedText = quoted?.msg?.text || quoted?.msg?.caption || quoted?.text || ''
        const match = (q || '').match(IG_RE) || String(quotedText).match(IG_RE)
        if (!match) return reply(`Usage: ${prefix}insta <Instagram reel / post link>`)

        if (!(await waitTurn(sender, conn, from, mek))) return

        const igUrl = match[0].split('?')[0]
        await conn.sendMessage(from, { react: { text: '⏳', key: mek.key } })

        const { data } = await axios.get(IG_API + encodeURIComponent(igUrl), { timeout: 30000 })
        const items = Array.isArray(data?.data) ? data.data.filter(i => i?.url) : []
        if (!data?.status || !items.length) throw new Error('NO_RESULT')

        const caption = CUSTOM || '𝑳𝜺𝝂𝜾⃮⃯⃔𝜶𝜼𝝄♪🤍'
        let sent = 0, lastErr = null
        for (const item of items.slice(0, IG_MAX_ITEMS)) {
            try {
                const { res } = await fetchSafe(item.url)
                const size = Number(res.headers['content-length'] || 0)
                if (size > MAX_BYTES) { res.data.destroy(); throw new Error('FILE_TOO_LARGE') }
                const buffer = await toBuffer(res.data)
                const msg = item.type === 'video'
                    ? { video: buffer, mimetype: 'video/mp4', caption }
                    : { image: buffer, caption }
                await conn.sendMessage(from, msg, { quoted: mek })
                sent++
            } catch (err) { lastErr = err; console.log('[IGDL] item failed:', err.message) }
        }

        if (!sent) throw lastErr || new Error('NO_RESULT')
        await conn.sendMessage(from, { react: { text: '✅', key: mek.key } })
    } catch (e) {
        console.log(e)
        conn.sendMessage(from, { react: { text: '❌', key: mek.key } }).catch(() => {})
        reply(friendly(e))
    }
})

const TW_RE = /https?:\/\/(?:www\.|mobile\.)?(?:twitter|x|fxtwitter|vxtwitter|fixupx)\.com\/(?:[A-Za-z0-9_]+|i(?:\/web)?)\/status(?:es)?\/(\d+)/i
const UA = { 'User-Agent': 'Mozilla/5.0' }
const TW_MAX_ITEMS = 10

async function twitterMedia(id) {
    try {
        const { data } = await axios.get(`https://api.fxtwitter.com/status/${id}`, { timeout: 20000, headers: UA })
        const t = data?.tweet
        const media = t?.media || t?.quote?.media
        const all = media?.all || [...(media?.videos || []), ...(media?.photos || [])]
        const items = all.filter(i => i?.url).map(i => ({ type: i.type === 'photo' ? 'image' : i.type, url: i.url }))
        if (items.length) return { items, text: t?.text || '', author: t?.author?.name || '' }
    } catch (e) { console.log('[TWITTER] fxtwitter failed:', e?.message || e) }

    try {
        const { data } = await axios.get(`https://api.vxtwitter.com/Twitter/status/${id}`, { timeout: 20000, headers: UA })
        const items = (data?.media_extended || []).filter(i => i?.url).map(i => ({ type: i.type, url: i.url }))
        if (items.length) return { items, text: data?.text || '', author: data?.user_name || '' }
    } catch (e) { console.log('[TWITTER] vxtwitter failed:', e?.message || e) }
    return null
}

cmd({
    pattern: "twitter",
    alias: ["tw", "twdl", "xdl", "twitterdl"],
    desc: "Download Twitter / X videos, GIFs and photos. Usage: /twitter <tweet link>",
    category: "download",
    react: "🐦",
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, quoted, sender, getSettings, reply }) => {
    try {
        const CUSTOM = await customCaption(getSettings)
        const quotedText = quoted?.msg?.text || quoted?.msg?.caption || quoted?.text || ''
        const match = (q || '').match(TW_RE) || String(quotedText).match(TW_RE)
        if (!match) return reply(`Usage: ${prefix}twitter <tweet link>`)
        if (!(await waitTurn(sender, conn, from, mek))) return
        await waitReact(conn, from, mek)

        const found = await twitterMedia(match[1])
        if (!found) {
            let file
            try { file = await ytdlpDownload(match[0], { kind: 'video', maxBytes: MAX_BYTES }) }
            catch (err) { if (err.message === 'FILE_TOO_LARGE') throw err; console.log('[TWITTER] yt-dlp failed:', err.message); throw new Error('NO_MEDIA') }
            return await conn.sendMessage(from, { video: file.buffer, mimetype: 'video/mp4', caption: CUSTOM || '𝑳𝜺𝝂𝜾⃮⃯⃔𝜶𝜼𝝄♪🤍' }, { quoted: mek })
        }

        const text = found.text.replace(/https?:\/\/t\.co\/\S+/g, '').trim().slice(0, 300)
        const caption = CUSTOM || `${found.author ? `*${found.author}*\n` : ''}${text}`.trim() || '𝑳𝜺𝝂𝜾⃮⃯⃔𝜶𝜼𝝄♪ 🤍'
        let sent = 0, lastErr = null
        for (const item of found.items.slice(0, TW_MAX_ITEMS)) {
            try {
                const { res } = await fetchSafe(item.url)
                const size = Number(res.headers['content-length'] || 0)
                if (size > MAX_BYTES) { res.data.destroy(); throw new Error('FILE_TOO_LARGE') }
                const buffer = await toBuffer(res.data)
                const cap = sent === 0 ? caption : undefined
                let msg
                if (item.type === 'video') msg = { video: buffer, mimetype: 'video/mp4', caption: cap }
                else if (item.type === 'gif') msg = { video: buffer, mimetype: 'video/mp4', gifPlayback: true, caption: cap }
                else msg = { image: buffer, caption: cap }
                await conn.sendMessage(from, msg, { quoted: mek })
                sent++
            } catch (err) { lastErr = err; console.log('[TWITTER] item failed:', err.message) }
        }
        if (!sent) throw lastErr || new Error('NO_MEDIA')
    } catch (e) { console.log(e); reply(friendly(e)) }
})

const FB_RE = /https?:\/\/(?:[a-z0-9-]+\.)?(?:facebook\.com|fb\.watch|fb\.com)\/[^\s]+/i

cmd({
    pattern: "facebook",
    alias: ["fb", "fbdl", "facebookdl"],
    desc: "Download a public Facebook video or reel. Usage: /facebook <link>",
    category: "download",
    react: "📘",
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, quoted, sender, getSettings, reply }) => {
    try {
        const CUSTOM = await customCaption(getSettings)
        const quotedText = quoted?.msg?.text || quoted?.msg?.caption || quoted?.text || ''
        const match = (q || '').match(FB_RE) || String(quotedText).match(FB_RE)
        if (!match) return reply(`Usage: ${prefix}facebook <Facebook video / reel link>`)
        if (!(await waitTurn(sender, conn, from, mek))) return
        await waitReact(conn, from, mek)

        const { buffer } = await ytdlpDownload(match[0], { kind: 'video', maxBytes: MAX_BYTES })
        await conn.sendMessage(from, { video: buffer, mimetype: 'video/mp4', caption: CUSTOM || '𝑳𝜺𝝂𝜾⃮⃯⃔𝜶𝜼𝝄♪🤍' }, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})

cmd({
    pattern: "dl",
    alias: ["download", "getfile"],
    desc: "Download a file from a direct link. Usage: /dl <url>",
    category: "download",
    react: "📥",
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, sender, reply }) => {
    try {
        const link = (q || '').trim().split(/\s+/)[0]
        if (!/^https?:\/\//i.test(link)) return reply(`Usage: ${prefix}dl <direct file link>`)
        if (!(await waitTurn(sender, conn, from, mek))) return
        const { res, url } = await fetchSafe(link)
        const size = Number(res.headers['content-length'] || 0)
        if (size > MAX_BYTES) { res.data.destroy(); throw new Error('FILE_TOO_LARGE') }
        await waitReact(conn, from, mek)
        const buffer = await toBuffer(res.data)
        const mime = (res.headers['content-type'] || 'application/octet-stream').split(';')[0].trim()
        const disp = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(res.headers['content-disposition'] || '')
        const name = decodeURIComponent(disp?.[1] || new URL(url).pathname.split('/').pop() || 'file') || 'file'
        let msg
        if (mime.startsWith('image/')) msg = { image: buffer, caption: name }
        else if (mime.startsWith('video/')) msg = { video: buffer, mimetype: mime, caption: name }
        else if (mime.startsWith('audio/')) msg = { audio: buffer, mimetype: mime, fileName: name }
        else msg = { document: buffer, mimetype: mime, fileName: name }
        await conn.sendMessage(from, msg, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})

module.exports = { searchSong, downloadMp3, toSeconds, YT_RE, MAX_MINUTES, fetchSafe, toBuffer, friendly, MAX_BYTES }


const YT_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

function extractYouTubeId(input) {
    const patterns = [
        /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/watch\?(?:[^\s&]*&)*v=([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
        /^(?=[a-zA-Z0-9_-]*[0-9_-])([a-zA-Z0-9_-]{11})$/
    ];
    for (const re of patterns) {
        const match = input.match(re);
        if (match) return match[1];
    }
    return null;
}

const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
