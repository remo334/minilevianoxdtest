//Xeno Exe
// One numbered sticker list. Stickers are s1, s2, s3 ...
//
//   s3  /  .s3          -> reply to a message with this; the bot reacts to it with sticker 3
//                          (plain "s3" works for the bot owner, ".s3" works for everyone the mode allows)
//   .slist              -> list of sticker numbers      .slist 3 -> show sticker 3      .slist all -> show them all
//   .s 3  /  .sr 3      -> same as s3
//   .s <emoji>          -> reply to a message; normal emoji reaction (e.g. .s 😂)
//   .s  /  .sr          -> on an image/video/GIF: makes a sticker (.sr also reacts with it)
//   .sadd               -> owner; reply to a sticker / image / video / GIF to add it to the list
//   .sdel <number>      -> owner; remove a sticker from the list (numbers after it shift down)
//
// Files live in stickers/ (any .webp, one folder deep). stickers/index.json keeps the order.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { getContentType, downloadContentFromMessage } = require('@whiskeysockets/baileys')
const { cmd, commands } = require('../command')
const sendStickerReaction = require('../lib/stickerreact')

let FFMPEG = 'ffmpeg'
try { FFMPEG = require('ffmpeg-static') || 'ffmpeg' } catch (e) { }
if (process.env.FFMPEG_PATH) FFMPEG = process.env.FFMPEG_PATH

const PACK_DIR = path.join(__dirname, '..', 'stickers')
const INDEX_FILE = path.join(PACK_DIR, 'index.json')
const ADD_DIR = 'react'                       // stickers added with .sadd go in stickers/react/
const MAX_STICKERS = 200
const MAX_STICKER_BYTES = 1024 * 1024
const MAX_MEDIA_BYTES = 40 * 1024 * 1024
const NEED_MEDIA = '_*Please reply to an image, video or GIF.*_'

const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)]
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- the numbered list -----------------------------------------------------------

function scanAll() {
    const out = []
    try {
        for (const d of fs.readdirSync(PACK_DIR, { withFileTypes: true })) {
            if (d.isFile() && d.name.toLowerCase().endsWith('.webp')) out.push(d.name)
            else if (d.isDirectory()) {
                for (const f of fs.readdirSync(path.join(PACK_DIR, d.name))) {
                    if (f.toLowerCase().endsWith('.webp')) out.push(`${d.name}/${f}`)
                }
            }
        }
    } catch (e) { }
    return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

function saveList(list) {
    try {
        fs.mkdirSync(PACK_DIR, { recursive: true })
        fs.writeFileSync(INDEX_FILE, JSON.stringify(list, null, 1))
    } catch (e) { console.log('[STICKER] could not save index:', e.message) }
}

// Ordered list of sticker files. Saved order first, new files on disk appended at the end.
function stickerList() {
    let saved = []
    try { saved = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) } catch (e) { }
    if (!Array.isArray(saved)) saved = []
    const all = scanAll()
    const onDisk = new Set(all)
    const list = saved.filter(f => onDisk.has(f))
    const known = new Set(list)
    for (const f of all) if (!known.has(f)) list.push(f)
    if (JSON.stringify(list) !== JSON.stringify(saved)) saveList(list)
    return list
}

const readSticker = (rel) => fs.readFileSync(path.join(PACK_DIR, rel))

// "3" or "s3" -> 3 (or null)
const parseNumber = (t) => {
    const m = /^s?(\d{1,3})$/i.exec(String(t || '').trim())
    return m ? Number(m[1]) : null
}

// ---- helpers ---------------------------------------------------------------------

// First emoji of a string (WhatsApp reactions hold exactly one), or null.
function firstEmoji(str) {
    str = String(str || '')
    if (!/\p{Extended_Pictographic}/u.test(str)) return null
    const seg = typeof Intl.Segmenter === 'function'
        ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str)].map(x => x.segment)
        : Array.from(str)
    return seg.find(g => /\p{Extended_Pictographic}/u.test(g)) || null
}

// Rebuild the message being replied to, so we can react to it / quote it.
function quotedOf(mek, from, botNumber) {
    const msg = mek.message || {}
    const ci = msg[getContentType(msg)]?.contextInfo
    if (!ci?.quotedMessage || !ci.stanzaId) return null
    const who = String(ci.participant || '').split('@')[0].split(':')[0]
    return {
        key: {
            remoteJid: from,
            fromMe: !!who && who === botNumber,
            id: ci.stanzaId,
            participant: from.endsWith('@g.us') ? ci.participant : undefined
        },
        message: ci.quotedMessage
    }
}

let warnedFallback = false
// React to message `qm` with a sticker. Falls back to a quoted sticker reply when this
// Baileys build cannot send sticker reactions (see lib/stickerreact.js).
async function reactWithSticker(conn, from, qm, sticker) {
    try {
        await sendStickerReaction(conn, from, qm.key, sticker)
    } catch (e) {
        if (e.code !== 'STICKER_REACTION_UNSUPPORTED') throw e
        if (!warnedFallback) {
            warnedFallback = true
            console.log('[STICKER] native sticker reactions are not available in this Baileys build; sending the sticker as a reply instead. See lib/stickerreact.js')
        }
        await conn.sendMessage(from, { sticker }, { quoted: qm })
    }
}

// Sticker number n from the list -> { buf } or { error }
function stickerByNumber(n, prefix) {
    const list = stickerList()
    if (!list.length) return { error: `No stickers yet.\nOwner: reply to a sticker with *${prefix}sadd* to add one.` }
    if (!n || n < 1 || n > list.length) return { error: `There is no sticker *s${n}*. You have s1 to s${list.length}. Send *${prefix}slist*` }
    return { buf: readSticker(list[n - 1]) }
}

function randomSticker(prefix) {
    const list = stickerList()
    if (!list.length) return { error: `No stickers yet.\nOwner: reply to a sticker with *${prefix}sadd* to add one.` }
    return { buf: readSticker(pickRandom(list)) }
}

// ---- image / video / GIF -> sticker ----------------------------------------------

function unwrap(message) {
    let msg = message || {}
    for (let i = 0; i < 4; i++) {
        const inner = msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message ||
            msg.viewOnceMessageV2Extension?.message || msg.ephemeralMessage?.message ||
            msg.documentWithCaptionMessage?.message
        if (!inner) break
        msg = inner
    }
    return msg
}

function mediaOf(message) {
    const msg = unwrap(message)
    if (msg.imageMessage) return { type: 'image', node: msg.imageMessage }
    if (msg.videoMessage) return { type: 'video', node: msg.videoMessage }   // GIFs are videos with gifPlayback
    if (msg.stickerMessage) return { type: 'sticker', node: msg.stickerMessage }
    return null
}

async function download(node, type) {
    const chunks = []
    let size = 0
    for await (const c of await downloadContentFromMessage(node, type)) {
        size += c.length
        if (size > MAX_MEDIA_BYTES) throw new Error('FILE_TOO_LARGE')
        chunks.push(c)
    }
    return Buffer.concat(chunks)
}

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
        let err = ''
        p.stderr.on('data', c => { err = (err + c).slice(-1500) })
        p.on('error', () => reject(new Error('NO_FFMPEG')))
        p.on('close', code => {
            if (code === 0) return resolve()
            console.log('[FFMPEG] failed (code ' + code + '):\n' + err)
            reject(new Error('FFMPEG_FAILED'))
        })
    })
}

async function toSticker(input, isVideo) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xeno-sr-'))
    try {
        const inFile = path.join(dir, 'in'), outFile = path.join(dir, 'out.webp')
        await fs.promises.writeFile(inFile, input)
        const vf = 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
        const args = ['-y', '-i', inFile, '-vf', isVideo ? vf + ',fps=15' : vf]
        if (isVideo) args.push('-t', '8', '-an')
        args.push('-c:v', 'libwebp', '-lossless', '0', '-q:v', '60', '-loop', '0', '-f', 'webp', outFile)
        await runFfmpeg(args)
        return await fs.promises.readFile(outFile)
    } finally {
        fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
}

// ---- commands --------------------------------------------------------------------

// Reply to a message with "s3" (owner) or ".s3" (anyone the bot mode allows) -> react with sticker 3.
cmd({
    on: 'body',
    dontAddCommandList: true,
    filename: __filename
},
async (conn, mek, m, { from, body, prefix, isOwner, botNumber, reply }) => {
    try {
        const text = String(body || '').trim()
        const hit = new RegExp(`^(${esc(prefix)})?s(\\d{1,3})$`, 'i').exec(text)
        if (!hit) return
        if (!hit[1] && !isOwner) return           // bare "s3" is owner only, so normal chat is never hijacked
        const qm = quotedOf(mek, from, botNumber)
        if (!qm) return                           // nothing to react to: stay quiet
        const r = stickerByNumber(Number(hit[2]), prefix)
        if (r.error) return reply(r.error)
        await reactWithSticker(conn, from, qm, r.buf)
    } catch (e) {
        console.log('[STICKER s#]', e)
    }
})

cmd({
    pattern: 'slist',
    alias: ['stickerlist', 'spacks'],
    desc: 'List stickers as s1, s2, s3... Usage: .slist  |  .slist 3  |  .slist all',
    category: 'convert',
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, reply }) => {
    try {
        const list = stickerList()
        if (!list.length) return reply(`No stickers yet.\nOwner: reply to a sticker with *${prefix}sadd* to add one.`)
        const arg = (q || '').trim().toLowerCase()

        if (arg === 'all') {
            const n = Math.min(list.length, 30)
            await reply(`Sending s1 to s${n} in order...`)
            for (let i = 0; i < n; i++) {
                await conn.sendMessage(from, { sticker: readSticker(list[i]) })
                await new Promise(r => setTimeout(r, 700))
            }
            return
        }
        if (arg) {
            const num = parseNumber(arg)
            const r = stickerByNumber(num, prefix)
            if (r.error) return reply(r.error)
            await reply(`*s${num}*`)
            return await conn.sendMessage(from, { sticker: r.buf })
        }

        const labels = list.map((_, i) => `s${i + 1}`)
        const rows = []
        for (let i = 0; i < labels.length; i += 10) rows.push('│ ' + labels.slice(i, i + 10).join('  '))
        reply(`*STICKER LIST* (${list.length})\n${rows.join('\n')}\n\nReply to a message with *s1*, *s2*...\nto react with that sticker.\n\n➱ ${prefix}slist 3  (see s3)\n➱ ${prefix}slist all  (see all)\n➱ ${prefix}s 😂  (emoji reaction)`)
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})

cmd({
    pattern: 's',
    desc: 'React to a replied message. .s <emoji> (emoji), .s <number> (sticker). On an image/video with no args it makes a sticker.',
    category: 'convert',
    filename: __filename
},
async (conn, mek, m, ctx) => {
    const { from, args, prefix, botNumber, reply } = ctx
    try {
        const qm = quotedOf(mek, from, botNumber)

        // Plain ".s" on nothing / an image / a video = the original sticker maker.
        const isMedia = !!(qm && (qm.message.imageMessage || qm.message.videoMessage))
        if (!args.length && (!qm || isMedia)) {
            const maker = commands.find(c => c.pattern === 'sticker')
            if (maker) return await maker.function(conn, mek, m, ctx)
        }

        if (!qm) return reply(`Reply to a message with *${prefix}s <emoji>* or *${prefix}s <number>*\nSee the list: *${prefix}slist*`)

        // ".s 😂" -> native WhatsApp emoji reaction on the replied message
        const emoji = firstEmoji(args[0])
        if (emoji) return await conn.sendMessage(from, { react: { text: emoji, key: qm.key } })

        const r = args.length ? stickerByNumber(parseNumber(args[0]), prefix) : randomSticker(prefix)
        if (r.error) return reply(r.error)
        await reactWithSticker(conn, from, qm, r.buf)
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})

cmd({
    pattern: 'sr',
    alias: ['sreact'],
    desc: 'Sticker reaction. .sr <number> reacts with that sticker. On an image/video/GIF, .sr makes a sticker and reacts with it.',
    category: 'convert',
    filename: __filename
},
async (conn, mek, m, { from, args, prefix, botNumber, reply }) => {
    try {
        const qm = quotedOf(mek, from, botNumber)
        if (!qm) return reply(NEED_MEDIA)

        let sticker
        if (args.length) {
            const r = stickerByNumber(parseNumber(args[0]), prefix)
            if (r.error) return reply(r.error)
            sticker = r.buf
        } else {
            const media = mediaOf(qm.message)
            if (!media) return reply(NEED_MEDIA)
            if (media.type === 'video' && Number(media.node.seconds || 0) > 10) return reply('Video is too long. Use a video under 10 seconds.')
            const buf = await download(media.node, media.type)
            sticker = media.type === 'sticker' ? buf : await toSticker(buf, media.type === 'video')
        }
        await reactWithSticker(conn, from, qm, sticker)
    } catch (e) {
        console.log(e)
        reply(String(e?.message) === 'FILE_TOO_LARGE' ? 'That file is too large.' : '_SORRY, ERROR. TRY AGAIN_')
    }
})

cmd({
    pattern: 'sadd',
    alias: ['addsticker'],
    desc: 'Owner: add to the sticker list. Reply to a sticker, image, video or GIF with .sadd',
    category: 'convert',
    filename: __filename
},
async (conn, mek, m, { from, prefix, botNumber, isOwner, reply }) => {
    try {
        if (!isOwner) return reply('Only the bot owner can use this command.')
        const qm = quotedOf(mek, from, botNumber)
        const media = qm && mediaOf(qm.message)
        if (!media) return reply(`Reply to a sticker, image, video or GIF with *${prefix}sadd*`)
        if (media.type === 'video' && Number(media.node.seconds || 0) > 10) return reply('Video is too long. Use a video under 10 seconds.')

        const list = stickerList()
        if (list.length >= MAX_STICKERS) return reply(`The list is full (${MAX_STICKERS} stickers). Remove one with *${prefix}sdel <number>*`)

        const raw = await download(media.node, media.type)
        const sticker = media.type === 'sticker' ? raw : await toSticker(raw, media.type === 'video')
        if (sticker.length > MAX_STICKER_BYTES) return reply('That sticker is too large (over 1 MB). Try a shorter or smaller one.')

        const rel = `${ADD_DIR}/${Date.now()}.webp`
        fs.mkdirSync(path.join(PACK_DIR, ADD_DIR), { recursive: true })
        fs.writeFileSync(path.join(PACK_DIR, rel), sticker)
        list.push(rel)
        saveList(list)
        reply(`Added as *s${list.length}*\nReply to a message with *s${list.length}* to react with it.`)
    } catch (e) {
        console.log(e)
        reply(String(e?.message) === 'FILE_TOO_LARGE' ? 'That file is too large.' : '_SORRY, ERROR. TRY AGAIN_')
    }
})

cmd({
    pattern: 'sdel',
    alias: ['delsticker'],
    desc: 'Owner: remove a sticker from the list. Usage: .sdel <number>',
    category: 'convert',
    filename: __filename
},
async (conn, mek, m, { args, prefix, isOwner, reply }) => {
    try {
        if (!isOwner) return reply('Only the bot owner can use this command.')
        const n = parseNumber(args[0])
        const list = stickerList()
        if (!n || n > list.length) return reply(`Use *${prefix}sdel <number>*  (you have s1 to s${list.length})`)
        const [rel] = list.splice(n - 1, 1)
        try { fs.unlinkSync(path.join(PACK_DIR, rel)) } catch (e) { }
        saveList(list)
        reply(`Removed *s${n}*. Stickers after it moved down by one.`)
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})
