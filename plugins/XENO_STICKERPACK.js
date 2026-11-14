//Xeno Exe
// Sticker packs + "react with a sticker".
//
//   .slist              -> list all sticker packs
//   .slist <pack>       -> list the stickers inside one pack
//   .s <emoji>          -> reply to a message; reacts to it with that emoji (e.g. .s 😂)
//   .sr                 -> reply to an image / video / GIF; makes a sticker and reacts with it
//   .sr <pack> [sticker]-> same as .s <pack> [sticker]
//   .s <pack> [sticker] -> reply to a message; the bot answers it with a sticker
//   .s                  -> reply to a (non-image) message; bot answers with a random sticker
//   .s                  -> reply to an image/video; unchanged, makes a sticker (old behaviour)
//   .sadd <pack> [name] -> owner only; reply to a sticker to save it into a pack
//
// Packs are plain folders of .webp files:  stickers/<packname>/<anything>.webp
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
const MAX_PER_PACK = 60
const MAX_STICKER_BYTES = 1024 * 1024
const MAX_MEDIA_BYTES = 40 * 1024 * 1024
const NEED_MEDIA = '_*Please reply to an image, video or GIF.*_'

const safeName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30)
const base = (f) => f.replace(/\.webp$/i, '')
const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)]

function filesOf(pack) {
    try {
        return fs.readdirSync(path.join(PACK_DIR, pack))
            .filter(f => f.toLowerCase().endsWith('.webp'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    } catch { return [] }
}

function listPacks() {
    try {
        return fs.readdirSync(PACK_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort()
            .map(name => ({ name, files: filesOf(name) }))
            .filter(p => p.files.length)
    } catch { return [] }
}

// pack by number (1-based, as shown in .slist) or by name
function findPack(packs, key) {
    key = String(key || '').toLowerCase()
    if (/^\d+$/.test(key)) return packs[Number(key) - 1]
    return packs.find(p => p.name === key)
}

// sticker by number (1-based), by file name, or random when omitted
function findFile(pack, key) {
    if (!key || ['r', 'random'].includes(String(key).toLowerCase())) return pickRandom(pack.files)
    key = String(key).toLowerCase()
    if (/^\d+$/.test(key)) return pack.files[Number(key) - 1]
    return pack.files.find(f => base(f).toLowerCase() === key)
}

// First emoji of a string (WhatsApp reactions hold exactly one), or null.
function firstEmoji(str) {
    str = String(str || '')
    if (!/\p{Extended_Pictographic}/u.test(str)) return null
    const seg = typeof Intl.Segmenter === 'function'
        ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str)].map(x => x.segment)
        : Array.from(str)
    return seg.find(g => /\p{Extended_Pictographic}/u.test(g)) || null
}

// Rebuild the message being replied to, so the sticker can quote it.
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

// ---- sending ---------------------------------------------------------------------

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

// Choose a sticker from the packs. args = [pack, sticker]. Returns { buf } or { error }.
function stickerFromPack(args, prefix) {
    const packs = listPacks()
    if (!packs.length) return { error: `No sticker packs yet.\nOwner: reply to a sticker with *${prefix}sadd <packname>* to start one.` }
    let pack, file
    if (!args.length) {
        pack = pickRandom(packs)
        file = pickRandom(pack.files)
    } else {
        pack = findPack(packs, args[0])
        if (!pack) return { error: `Pack *${args[0]}* not found. Send *${prefix}slist* to see all packs.` }
        file = findFile(pack, args[1])
        if (!file) return { error: `Sticker *${args[1]}* not found in *${pack.name}*. Send *${prefix}slist ${pack.name}*` }
    }
    return { buf: fs.readFileSync(path.join(PACK_DIR, pack.name, file)) }
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

cmd({
    pattern: 'slist',
    alias: ['stickerlist', 'spacks'],
    desc: 'List sticker packs. Usage: .slist  or  .slist <pack>',
    category: 'convert',
    filename: __filename
},
async (conn, mek, m, { q, prefix, reply }) => {
    try {
        const packs = listPacks()
        if (!packs.length) {
            return reply(`No sticker packs yet.\nOwner: reply to a sticker with *${prefix}sadd <packname>* to start one.`)
        }
        const key = (q || '').trim().split(/ +/)[0]
        if (key) {
            const pack = findPack(packs, key)
            if (!pack) return reply(`Pack *${key}* not found. Send *${prefix}slist* to see all packs.`)
            const lines = pack.files.map((f, i) => `│ ${i + 1}. ${base(f)}`)
            return reply(`*${pack.name.toUpperCase()}* (${pack.files.length})\n${lines.join('\n')}\n\nReply to a message with:\n➱ ${prefix}s ${pack.name} <number or name>\n➱ ${prefix}s ${pack.name}  (random)`)
        }
        const lines = packs.map((p, i) => `│ ${i + 1}. ${p.name}  (${p.files.length})`)
        reply(`*STICKER PACKS*\n${lines.join('\n')}\n\nReply to a message with:\n➱ ${prefix}s <emoji>  (emoji reaction, e.g. ${prefix}s 😂)\n➱ ${prefix}sr  (on an image/video/GIF: sticker reaction)\n➱ ${prefix}s <pack> [number or name]\n➱ ${prefix}s  (random sticker)\n➱ ${prefix}slist <pack>  (see stickers inside)`)
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})

cmd({
    pattern: 's',
    desc: 'React to a replied message. Usage: .s <emoji> (emoji reaction) or .s <pack> [number|name] (sticker). On an image/video with no args it makes a sticker.',
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

        if (!qm) return reply(`Reply to a message with *${prefix}s <emoji>* or *${prefix}s <pack>*\nSee packs: *${prefix}slist*`)

        // ".s 😂" -> native WhatsApp emoji reaction on the replied message
        const emoji = firstEmoji(args[0])
        if (emoji) return await conn.sendMessage(from, { react: { text: emoji, key: qm.key } })

        const r = stickerFromPack(args, prefix)
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
    desc: 'Sticker reaction. Reply to an image/video/GIF with .sr (makes a sticker and reacts with it), or .sr <pack> [number|name] on any message.',
    category: 'convert',
    filename: __filename
},
async (conn, mek, m, { from, args, prefix, botNumber, reply }) => {
    try {
        const qm = quotedOf(mek, from, botNumber)
        if (!qm) return reply(NEED_MEDIA)

        let sticker
        if (args.length) {
            const r = stickerFromPack(args, prefix)
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
    desc: 'Owner: save a replied sticker into a pack. Usage: reply to a sticker with .sadd <pack> [name]',
    category: 'convert',
    filename: __filename
},
async (conn, mek, m, { from, args, prefix, botNumber, isOwner, reply }) => {
    try {
        if (!isOwner) return reply('Only the bot owner can use this command.')
        const qm = quotedOf(mek, from, botNumber)
        const node = qm?.message?.stickerMessage
        if (!node) return reply(`Reply to a sticker with *${prefix}sadd <packname> [name]*`)

        const pack = safeName(args[0])
        if (!pack) return reply(`Give a pack name: *${prefix}sadd <packname> [name]*`)
        if (/^\d+$/.test(pack)) return reply('Pack name needs at least one letter (numbers are used to pick packs).')

        const dir = path.join(PACK_DIR, pack)
        const existing = filesOf(pack)
        if (existing.length >= MAX_PER_PACK) return reply(`Pack *${pack}* is full (${MAX_PER_PACK} stickers).`)

        const name = safeName(args[1]) || String(existing.length + 1)
        const file = `${name}.webp`
        if (existing.includes(file)) return reply(`*${pack}* already has a sticker named *${name}*.`)

        const chunks = []
        let size = 0
        for await (const c of await downloadContentFromMessage(node, 'sticker')) {
            size += c.length
            if (size > MAX_STICKER_BYTES) return reply('That sticker is too large.')
            chunks.push(c)
        }
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, file), Buffer.concat(chunks))
        reply(`Saved to *${pack}* as *${name}* (pack now has ${existing.length + 1}).`)
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})
