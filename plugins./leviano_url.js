//Xeno Exe
const mime = require('mime-types')
const { downloadContentFromMessage } = require('@whiskeysockets/baileys')
const { cmd } = require('../command')

const MAX_BYTES = 50 * 1024 * 1024
const COOLDOWN_MS = 5000
const lastUse = new Map()

const cooldown = (id) => {
    const wait = (lastUse.get(id) || 0) + COOLDOWN_MS - Date.now()
    if (wait > 0) return Math.ceil(wait / 1000)
    lastUse.set(id, Date.now())
    return 0
}

const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage']
function pickMedia(msg) {
    if (!msg || typeof msg !== 'object') return null
    for (let i = 0; i < 4; i++) {
        const inner = msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message ||
            msg.viewOnceMessageV2Extension?.message || msg.ephemeralMessage?.message ||
            msg.documentWithCaptionMessage?.message
        if (!inner) break
        msg = inner
    }
    const type = MEDIA_TYPES.find(t => msg[t])
    return type ? { type, node: msg[type] } : null
}

async function download(sel) {
    const stream = await downloadContentFromMessage(sel.node, sel.type.replace('Message', ''))
    const chunks = []
    let size = 0
    for await (const c of stream) {
        size += c.length
        if (size > MAX_BYTES) throw new Error('FILE_TOO_LARGE')
        chunks.push(c)
    }
    return Buffer.concat(chunks)
}

const BASE = (process.env.XENODRIVE_BASE || 'https://xenoexex.onrender.com').replace(/\/+$/, '')
const CHUNK = 8 * 1024 * 1024
const UA = 'Mozilla/5.0 (compatible; XenoXD/1.0)'
const TIMEOUT = 120000
const POLL_MS = 1000
const POLL_MAX = 180

const isUrl = (t) => /^https?:\/\/\S+$/i.test(String(t || '').trim())
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(path, opts = {}) {
    const res = await fetch(BASE + path, {
        ...opts,
        headers: { 'User-Agent': UA, ...(opts.headers || {}) },
        signal: AbortSignal.timeout(TIMEOUT)
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    if (!res.ok || json?.error) throw new Error('UPLOAD_FAILED:' + res.status + ' ' + (json?.error || text.slice(0, 120)))
    return json || {}
}

function findLink(o) {
    if (!o || typeof o !== 'object') return null
    const f = o.file && typeof o.file === 'object' ? o.file : o
    const cand = [o.link, o.url, o.shareUrl, o.share_url, o.shareLink, f.link, f.url, f.shareUrl, f.share_url, f.shareLink]
    for (const c of cand) {
        if (typeof c !== 'string' || !c.trim()) continue
        const v = c.trim()
        if (isUrl(v)) return v
        if (v.startsWith('/')) return BASE + v
    }
    return null
}

async function uploadToDrive(buffer, fileName, mimetype) {
    const init = await api('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fileName, size: buffer.length, mime: mimetype })
    })
    const id = init.id
    if (!id) throw new Error('UPLOAD_FAILED:init')

    try {
        for (let i = 0; i * CHUNK < buffer.length; i++) {
            await api(`/api/upload/${id}/chunk?index=${i}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: buffer.subarray(i * CHUNK, (i + 1) * CHUNK)
            })
        }
        await api(`/api/upload/${id}/complete`, { method: 'POST' })
    } catch (e) {
        api(`/api/upload/${id}`, { method: 'DELETE' }).catch(() => {})
        throw e
    }

    let st = {}
    for (let i = 0; i < POLL_MAX; i++) {
        await sleep(POLL_MS)
        st = await api(`/api/upload/${id}`)
        if (st.status === 'done' || st.status === 'error') break
    }
    if (st.status === 'error') throw new Error('UPLOAD_FAILED:' + (st.error || 'processing'))
    if (st.status !== 'done') throw new Error('timeout')

    let fileId = st.fileId ?? st.file_id ?? st.file?.id ?? st.fileID ?? null
    const direct = findLink(st)
    if (!fileId && direct) return direct

    if (!fileId) {
        const list = await api('/api/files?view=files')
        const arr = Array.isArray(list) ? list : (list.files || [])
        const hit = arr.find(f => f.name === fileName && Number(f.size) === buffer.length) || arr.find(f => f.name === fileName)
        fileId = hit?.id ?? null
        const l = findLink(hit)
        if (!fileId && l) return l
    }
    if (!fileId) throw new Error('UPLOAD_FAILED:no file id')

    try {
        const shared = await api(`/api/files/${fileId}/share`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        })
        const l = findLink(shared)
        if (l) return l
    } catch {}
    return `${BASE}/api/files/${fileId}/stream`
}

const friendly = (e) => {
    const m = String(e?.message || e)
    if (m === 'FILE_TOO_LARGE') return `That file is larger than ${MAX_BYTES / 1024 / 1024} MB.`
    if (m.startsWith('UPLOAD_FAILED')) return 'Upload failed. Try again in a moment.'
    if (/timeout|aborted/i.test(m)) return 'The upload took too long. Try a smaller file.'
    return '_SORRY, ERROR. TRY AGAIN_'
}

cmd({
    pattern: "url",
    alias: ["tourl", "upload", "xenodrive"],
    desc: "Upload media to Xeno Drive and get a link. Usage: reply to media with /url",
    category: "tools",
    react: "🔗",
    filename: __filename
},
async (conn, mek, m, { from, q, quoted, prefix, sender, reply }) => {
    try {
        const sel = pickMedia(quoted) || pickMedia(mek.message)
        if (!sel) return reply(`Reply to an image, video, audio, sticker or file with *${prefix}url*`)

        const wait = cooldown(sender || from)
        if (wait) return reply(`Please wait ${wait}s.`)
        await conn.sendMessage(from, { react: { text: '⏳', key: mek.key } }).catch(() => {})

        const buffer = await download(sel)
        const mimetype = sel.node.mimetype || 'application/octet-stream'
        const ext = mime.extension(String(mimetype).split(';')[0]) || 'bin'
        const fileName = sel.node.fileName || `xenoxd_${Date.now()}.${ext}`

        const link = await uploadToDrive(buffer, fileName, mimetype)
        await reply(`*${link}*`)
    } catch (e) { console.log('[URL]', e?.message || e); reply(friendly(e)) }
})
