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
const UPLOAD_URL = process.env.XENODRIVE_UPLOAD_URL || `${BASE}/api/upload`
const FIELD = process.env.XENODRIVE_FIELD || 'file'
const UA = 'Mozilla/5.0 (compatible; XenoXD/1.0)'
const TIMEOUT = 180000

const isUrl = (t) => /^https?:\/\/\S+$/i.test(String(t || '').trim())

function extractLink(text) {
    const t = String(text || '').trim()
    if (isUrl(t)) return t
    try {
        const j = JSON.parse(t)
        const cand = j?.url || j?.link || j?.shareUrl || j?.share_url || j?.downloadUrl || j?.download_url || j?.file?.url || j?.file_url || j?.fileUrl || j?.data?.url || j?.data?.link ||
            j?.result?.url || j?.files?.[0]?.url || (Array.isArray(j) ? j[0]?.url || j[0] : null)
        if (isUrl(cand)) return String(cand).trim()
        const path = j?.path || j?.file?.path || j?.file || j?.filename || j?.data?.path
        if (typeof path === 'string' && path && !/\s/.test(path)) return path.startsWith('http') ? path : `${BASE}/${path.replace(/^\/+/, '')}`
    } catch {}
    const m = t.match(/https?:\/\/[^\s"'<>]+/i)
    return m ? m[0] : null
}

async function uploadToDrive(buffer, fileName, mimetype) {
    const form = new FormData()
    form.append(FIELD, new Blob([buffer], { type: mimetype }), fileName)
    const res = await fetch(UPLOAD_URL, { method: 'POST', body: form, headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT) })
    const text = (await res.text()).trim()
    const link = res.ok ? extractLink(text) : null
    if (!link) throw new Error('UPLOAD_FAILED:' + res.status + ' ' + text.slice(0, 120))
    return link
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
