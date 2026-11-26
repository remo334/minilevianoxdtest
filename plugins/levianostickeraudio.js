// .stickeraudio -> sticker that plays audio
//   reply to a video                      -> uses the video's own sound
//   reply to a sticker/image, then audio  -> (either order) joins the two
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const {
    proto, getContentType, downloadContentFromMessage,
    prepareWAMessageMedia, generateWAMessageContent, generateWAMessageFromContent
} = require('@whiskeysockets/baileys')
const { cmd } = require('../command')

let FFMPEG = 'ffmpeg'
try { FFMPEG = require('ffmpeg-static') || 'ffmpeg' } catch (e) { }
if (process.env.FFMPEG_PATH) FFMPEG = process.env.FFMPEG_PATH

const VIDEO_SECONDS = 8
const AUDIO_SECONDS = 30
const MAX_BYTES = 40 * 1024 * 1024
const TTL = 10 * 60 * 1000
const pending = new Map()

// ---- protocol: Baileys 6.7 has no field for sticker audio, so we write it ourselves ----
// Message.134 (wrapper) > .1 (Message) > .26 stickerMessage > .24 premium, .25 emojis, .26 audioMessage
const EXTRA = '_stickerAudio'
const originalEncode = proto.Message.encode
proto.Message.encode = function (message, writer) {
    const sticker = message?.stickerMessage
    if (!sticker?.[EXTRA]) return originalEncode.call(this, message, writer)

    const rest = { ...message }
    delete rest.stickerMessage
    const w = originalEncode.call(this, rest, writer)
    const open = (field) => w.uint32((field << 3) | 2).fork()

    open(134); open(1); open(26)
    proto.Message.StickerMessage.encode(sticker, w)
    w.uint32(24 << 3).int32(0)
    w.uint32((25 << 3) | 2).string('🔊')
    proto.Message.AudioMessage.encode(sticker[EXTRA], open(26)).ldelim()
    w.ldelim(); w.ldelim(); w.ldelim()
    return w
}

// ---- media ---------------------------------------------------------------------------

function quotedOf(mek) {
    const msg = mek.message || {}
    return msg[getContentType(msg)]?.contextInfo?.quotedMessage || null
}

async function download(node, type) {
    if (Number(node.fileLength || 0) > MAX_BYTES) throw new Error('FILE_TOO_LARGE')
    const chunks = []
    for await (const c of await downloadContentFromMessage(node, type)) chunks.push(c)
    return Buffer.concat(chunks)
}

async function ffmpeg(input, ext, args) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stka-'))
    try {
        const src = path.join(dir, 'in')
        const out = path.join(dir, 'out.' + ext)
        fs.writeFileSync(src, input)
        await new Promise((resolve, reject) => execFile(FFMPEG, ['-y', '-i', src, ...args, out],
            { timeout: 90000, maxBuffer: 10 * 1024 * 1024 }, (err) => err ? reject(err) : resolve()))
        return fs.readFileSync(out)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

const toAudio = (buf, secs) => ffmpeg(buf, 'ogg',
    ['-vn', '-t', String(secs), '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '64k'])

function toSticker(buf, animated) {
    const fit = 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,' +
        'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
    return ffmpeg(buf, 'webp', animated
        ? ['-t', String(VIDEO_SECONDS), '-an', '-vf', 'fps=12,' + fit, '-c:v', 'libwebp', '-loop', '0', '-q:v', '35']
        : ['-frames:v', '1', '-vf', fit, '-c:v', 'libwebp', '-q:v', '70'])
}

async function sendAudioSticker(conn, jid, sticker, audio, quoted) {
    const upload = conn.waUploadToServer
    const { stickerMessage } = await generateWAMessageContent({ sticker }, { upload })
    const { audioMessage } = await prepareWAMessageMedia(
        { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { upload })
    delete audioMessage.ptt
    stickerMessage.isAnimated = sticker.includes('ANIM')

    const msg = generateWAMessageFromContent(jid, { stickerMessage }, { userJid: conn.user.id, quoted })
    // added after generating, otherwise Baileys drops the unknown property
    msg.message.stickerMessage[EXTRA] = audioMessage
    await conn.relayMessage(jid, msg.message, { messageId: msg.key.id })
}

// ---- command ---------------------------------------------------------------------------

cmd({
    pattern: 'stickeraudio',
    alias: ['sa'],
    desc: 'Sticker with audio. Reply to a video, or to a sticker/image and then an audio.',
    category: 'convert',
    filename: __filename
},
async (conn, mek, m, { from, sender, prefix, reply }) => {
    try {
        const q = quotedOf(mek)
        const type = ['video', 'audio', 'image', 'sticker'].find(t => q?.[t + 'Message'])
        if (!type) return reply(`Reply to a video, or to a sticker/image and an audio, with *${prefix}stickeraudio*`)

        const key = `${from}:${sender}`
        const old = pending.get(key)
        const state = old && Date.now() - old.at < TTL ? { ...old } : {}
        const buf = await download(q[type + 'Message'], type)

        if (type === 'audio') {
            state.audio = await toAudio(buf, AUDIO_SECONDS)
        } else if (type === 'video' && state.sticker && !state.audio) {
            state.audio = await toAudio(buf, AUDIO_SECONDS)
        } else {
            state.sticker = type === 'sticker' ? buf : await toSticker(buf, type === 'video')
            // a video with no sound just leaves the audio empty
            if (type === 'video' && !state.audio) state.audio = await toAudio(buf, VIDEO_SECONDS).catch(() => null)
        }

        if (!state.sticker || !state.audio) {
            pending.set(key, { ...state, at: Date.now() })
            return reply(state.sticker
                ? `Got the sticker. Now reply to an audio with *${prefix}stickeraudio*`
                : `Got the audio. Now reply to a sticker or image with *${prefix}stickeraudio*`)
        }

        pending.delete(key)
        await sendAudioSticker(conn, from, state.sticker, state.audio, mek)
    } catch (e) {
        console.log('[STICKERAUDIO]', e)
        reply(e.message === 'FILE_TOO_LARGE' ? 'That file is too large.' : 'Could not make the audio sticker.')
    }
})
