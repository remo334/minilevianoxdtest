//Monjan Nick
// .take / .steal
//   reply to a sticker : .take                     -> pack = bot name, author = your name
//                        .take Pack;Author         -> your own pack and author
//   reply to an audio  : .take                     -> title = bot name, artist = your name
//                        .take Title;Artist        -> your own title and artist
//                        .take Title;Artist;URL    -> also adds cover art (owner only, https image)
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { getContentType, downloadContentFromMessage } = require('@whiskeysockets/baileys')
const config = require('../config')
const { cmd } = require('../command')

let FFMPEG = 'ffmpeg'
try { FFMPEG = require('ffmpeg-static') || 'ffmpeg' } catch (e) { }
if (process.env.FFMPEG_PATH) FFMPEG = process.env.FFMPEG_PATH

const MAX_MEDIA_BYTES = 40 * 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

// ---- media ---------------------------------------------------------------------------

// The replied sticker or audio, also when wrapped (view once, disappearing messages)
function quotedMedia(mek) {
    const msg = mek.message || {}
    let q = msg[getContentType(msg)]?.contextInfo?.quotedMessage
    for (let i = 0; i < 4 && q; i++) {
        const inner = q.ephemeralMessage?.message || q.viewOnceMessage?.message ||
            q.viewOnceMessageV2?.message || q.viewOnceMessageV2Extension?.message ||
            q.lottieStickerMessage?.message
        if (!inner) break
        q = inner
    }
    if (q?.stickerMessage) return { type: 'sticker', node: q.stickerMessage }
    if (q?.audioMessage) return { type: 'audio', node: q.audioMessage }
    return null
}

async function download({ node, type }) {
    const chunks = []
    let size = 0
    for await (const c of await downloadContentFromMessage(node, type)) {
        size += c.length
        if (size > MAX_MEDIA_BYTES) throw new Error('FILE_TOO_LARGE')
        chunks.push(c)
    }
    return Buffer.concat(chunks)
}

// ---- sticker: write pack / author into the webp EXIF chunk ---------------------------

function buildExif(pack, author) {
    const json = Buffer.from(JSON.stringify({
        'sticker-pack-id': crypto.randomBytes(16).toString('hex'),
        'sticker-pack-name': pack,
        'sticker-pack-publisher': author,
        emojis: ['😂']
    }), 'utf8')
    const head = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
        0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ])
    head.writeUInt32LE(json.length, 14)
    return Buffer.concat([head, json])
}

function chunk(id, data) {
    const head = Buffer.alloc(8)
    head.write(id, 0, 'ascii')
    head.writeUInt32LE(data.length, 4)
    return Buffer.concat([head, data, Buffer.alloc(data.length & 1)])   // chunks are even sized
}

// A simple webp has no VP8X header, which is required before EXIF can be added
function makeVp8x(chunks) {
    const data = Buffer.alloc(10)
    let width, height
    const lossy = chunks.find(c => c.id === 'VP8 ')
    const lossless = chunks.find(c => c.id === 'VP8L')
    if (lossy) {
        width = lossy.data.readUInt16LE(6) & 0x3fff
        height = lossy.data.readUInt16LE(8) & 0x3fff
    } else if (lossless) {
        const bits = lossless.data.readUInt32LE(1)
        width = (bits & 0x3fff) + 1
        height = ((bits >>> 14) & 0x3fff) + 1
        if ((bits >>> 28) & 1) data[0] |= 0x10                          // has alpha
    } else throw new Error('BAD_WEBP')
    data.writeUIntLE(width - 1, 4, 3)
    data.writeUIntLE(height - 1, 7, 3)
    return { id: 'VP8X', data }
}

function setStickerInfo(webp, pack, author) {
    if (webp.toString('ascii', 0, 4) !== 'RIFF' || webp.toString('ascii', 8, 12) !== 'WEBP') {
        throw new Error('BAD_WEBP')
    }
    const chunks = []
    for (let at = 12; at + 8 <= webp.length;) {
        const id = webp.toString('ascii', at, at + 4)
        const size = webp.readUInt32LE(at + 4)
        if (id !== 'EXIF') chunks.push({ id, data: Buffer.from(webp.subarray(at + 8, at + 8 + size)) })
        at += 8 + size + (size & 1)
    }
    let header = chunks.find(c => c.id === 'VP8X')
    if (!header) chunks.unshift(header = makeVp8x(chunks))
    header.data[0] |= 0x08                                              // has EXIF

    // EXIF goes after the image data and before XMP
    const xmp = chunks.findIndex(c => c.id === 'XMP ')
    chunks.splice(xmp === -1 ? chunks.length : xmp, 0, { id: 'EXIF', data: buildExif(pack, author) })

    const body = Buffer.concat([Buffer.from('WEBP'), ...chunks.map(c => chunk(c.id, c.data))])
    return chunk('RIFF', body)
}

// ---- audio: title / artist / cover art -----------------------------------------------

async function fetchCover(url) {
    if (!/^https:\/\//i.test(url)) throw new Error('BAD_COVER')
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!res.ok || !String(res.headers.get('content-type')).startsWith('image/')) throw new Error('BAD_COVER')
    const parts = []
    let size = 0
    for await (const part of res.body) {
        size += part.length
        if (size > MAX_IMAGE_BYTES) throw new Error('BAD_COVER')
        parts.push(part)
    }
    return Buffer.concat(parts)
}

async function tagAudio(audio, title, artist, cover) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'take-'))
    try {
        const src = path.join(dir, 'in'), img = path.join(dir, 'cover'), out = path.join(dir, 'out.m4a')
        await fs.promises.writeFile(src, audio)
        const args = ['-y', '-i', src]
        if (cover) {
            await fs.promises.writeFile(img, cover)
            args.push('-i', img, '-map', '0:a', '-map', '1:v', '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p',
                '-frames:v', '1', '-disposition:v:0', 'attached_pic')
        } else {
            args.push('-map', '0:a')
        }
        args.push('-c:a', 'aac', '-b:a', '128k', '-map_metadata', '-1',
            '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, '-f', 'ipod', out)
        await new Promise((resolve, reject) => execFile(FFMPEG, args,
            { timeout: 90000, maxBuffer: 10 * 1024 * 1024 }, (err) => err ? reject(err) : resolve()))
        return await fs.promises.readFile(out)
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
}

// ---- command ---------------------------------------------------------------------------

cmd({
    pattern: 'take',
    alias: ['steal'],
    desc: 'Change sticker pack/author or audio title/artist. Reply with .take Name;Author',
    category: 'convert',
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, pushname, isOwner, reply }) => {
    try {
        const media = quotedMedia(mek)
        if (!media) return reply(`Reply to a sticker or audio with *${prefix}take Name;Author*`)

        const [first = '', second = '', ...rest] = String(q || '').split(';').map(s => s.trim())
        const url = rest.join(';')
        if (url && media.type === 'audio' && !isOwner) return reply('Only the bot owner can add cover art from a link.')

        const input = await download(media)

        if (media.type === 'sticker') {
            // With custom text an empty author stays empty
            const pack = first || config.BOT_NAME
            const author = String(q || '').trim() ? second : pushname
            return await conn.sendMessage(from, { sticker: setStickerInfo(input, pack, author) }, { quoted: mek })
        }

        const cover = url ? await fetchCover(url) : null
        const audio = await tagAudio(input, first || config.BOT_NAME, second || pushname, cover)
        await conn.sendMessage(from, { audio, mimetype: 'audio/mp4', ptt: false }, { quoted: mek })
    } catch (e) {
        console.log('[TAKE]', e)
        const msg = String(e?.message)
        reply(msg === 'FILE_TOO_LARGE' ? 'That file is too large.'
            : msg === 'BAD_COVER' ? 'Could not use that link. Give a direct https image link under 5 MB.'
            : msg === 'BAD_WEBP' ? 'This sticker type is not supported.'
            : '_SORRY, ERROR. TRY AGAIN_')
    }
})

module.exports = { setStickerInfo, tagAudio }
