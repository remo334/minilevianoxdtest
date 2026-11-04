//Xeno Exe
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { downloadContentFromMessage } = require('@whiskeysockets/baileys')
const config = require('../config')
const { cmd, commands } = require('../command')

let FFMPEG = 'ffmpeg'
try { FFMPEG = require('ffmpeg-static') || 'ffmpeg' } catch (e) { }
if (process.env.FFMPEG_PATH) FFMPEG = process.env.FFMPEG_PATH

const OWNER_ONLY = 'bot owner can use this command.'
const MAX_MEDIA_BYTES = 40 * 1024 * 1024
const COOLDOWN_MS = 5000
const lastUse = new Map()

const waitReact = (conn, from, mek) => conn.sendMessage(from, { react: { text: '⏳', key: mek.key } }).catch(() => {})

const cooldown = (id) => {
    const wait = lastUse.get(id) + COOLDOWN_MS - Date.now()
    if (wait > 0) return Math.ceil(wait / 1000)
    lastUse.set(id, Date.now())
    return 0
}

const runtime = (s) => {
    s = Math.floor(s)
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
    return `${d ? d + 'd ' : ''}${h ? h + 'h ' : ''}${m}m ${s % 60}s`
}

function runFfmpeg(args, collect = false, cwd, bin = FFMPEG) {
    return new Promise((resolve, reject) => {
        const p = spawn(bin, args, { cwd, stdio: ['ignore', collect ? 'pipe' : 'ignore', 'pipe'] })
        const chunks = []
        let err = ''
        if (collect) p.stdout.on('data', c => chunks.push(c))
        p.stderr.on('data', c => { err = (err + c).slice(-1500) })
        p.on('error', () => reject(new Error('NO_FFMPEG')))
        p.on('close', code => {
            if (code === 0) return resolve(Buffer.concat(chunks))
            console.log('[FFMPEG] failed (code ' + code + '):\n' + err)
            reject(new Error('FFMPEG_FAILED'))
        })
    })
}

const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage']
function pickMedia(quoted) {
    if (!quoted || typeof quoted !== 'object') return null
    let msg = quoted
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

async function downloadMedia(sel) {
    const stream = await downloadContentFromMessage(sel.node, sel.type.replace('Message', ''))
    const chunks = []
    let size = 0
    for await (const c of stream) {
        size += c.length
        if (size > MAX_MEDIA_BYTES) throw new Error('FILE_TOO_LARGE')
        chunks.push(c)
    }
    return Buffer.concat(chunks)
}

async function withTemp(fn) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xeno-'))
    try { return await fn(dir) }
    finally { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

async function makeWaveform(input) {
    try {
        const pcm = await runFfmpeg(['-i', input, '-vn', '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1'], true)
        const samples = pcm.length >> 1
        if (!samples) throw new Error('EMPTY')
        const bars = 64, size = Math.max(1, Math.floor(samples / bars))
        const vals = []
        for (let i = 0; i < bars; i++) {
            let sum = 0, n = 0
            for (let j = i * size; j < Math.min(samples, (i + 1) * size); j++) { sum += Math.abs(pcm.readInt16LE(j * 2)); n++ }
            vals.push(n ? sum / n : 0)
        }
        const max = Math.max(...vals) || 1
        return new Uint8Array(vals.map(v => Math.max(2, Math.floor((v / max) * 100))))
    } catch (e) {
        return new Uint8Array(64).fill(40)
    }
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
    if (m === 'FILE_TOO_LARGE') return 'That file is too large.'
    return sorry()
}

const needReply = (prefix, name, what) => `Reply to ${what} with *${prefix}${name}*`

cmd({
    pattern: "ping",
    alias: ["speed", "p"],
    desc: "Check bot's response time.",
    category: "main",
    react: "💱",
    filename: __filename
},
async (conn, mek, m, { from, reply }) => {
    try {
        const start = Date.now()
        const sent = await conn.sendMessage(from, { text: '*Pinging...*' }, { quoted: mek })
        const ping = Date.now() - start
        const text = `*Pong!*\n\nSpeed: *${ping} ms*\nUptime: *${runtime(process.uptime())}*`
        await conn.sendMessage(from, { text, edit: sent.key }).catch(() => reply(text))
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})

cmd({
    pattern: "vn",
    alias: ["tovn", "toptt", "voice"],
    desc: "Convert a replied audio or video into a voice note. Usage: reply with /vn",
    category: "convert",
    react: "🎙",
    filename: __filename
},
async (conn, mek, m, { from, quoted, prefix, sender, reply }) => {
    try {
        const sel = pickMedia(quoted)
        if (!sel || !['audioMessage', 'videoMessage'].includes(sel.type)) return reply(needReply(prefix, 'vn', 'an audio or video message'))
        const wait = cooldown(sender)
        if (wait) return
        await waitReact(conn, from, mek)
        const input = await downloadMedia(sel)
        const { audio, waveform } = await withTemp(async (dir) => {
            const inFile = path.join(dir, 'in'), outFile = path.join(dir, 'out.ogg')
            await fs.promises.writeFile(inFile, input)
            await runFfmpeg(['-y', '-i', inFile, '-vn', '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', '-f', 'ogg', outFile])
            return { audio: await fs.promises.readFile(outFile), waveform: await makeWaveform(outFile) }
        })
        await conn.sendMessage(from, { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true, waveform }, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})

async function revealViewOnce(conn, mek, quoted, to, reply, prefix, name) {
    const sel = pickMedia(quoted)
    if (!sel || !['imageMessage', 'videoMessage', 'audioMessage'].includes(sel.type)) {
        return reply(needReply(prefix, name, 'a view-once photo, video or voice note'))
    }
    await waitReact(conn, mek.key.remoteJid, mek)
    const buffer = await downloadMedia(sel)
    const caption = sel.node.caption || ''
    let msg
    if (sel.type === 'imageMessage') msg = { image: buffer, caption }
    else if (sel.type === 'videoMessage') msg = { video: buffer, caption, mimetype: sel.node.mimetype || 'video/mp4' }
    else msg = { audio: buffer, mimetype: sel.node.mimetype || 'audio/ogg; codecs=opus', ptt: !!sel.node.ptt }
    await conn.sendMessage(to, msg, to === mek.key.remoteJid ? { quoted: mek } : {})
}

cmd({
    pattern: "vv",
    alias: ["viewonce", "reveal"],
    desc: "Show a view-once message as normal media. Usage: reply with /vv",
    category: "convert",
    react: "👁",
    filename: __filename
},
async (conn, mek, m, { from, quoted, prefix, isOwner, reply }) => {
    try {
        if (!isOwner) return reply(OWNER_ONLY)
        await revealViewOnce(conn, mek, quoted, from, reply, prefix, 'vv')
    } catch (e) { console.log(e); reply(friendly(e)) }
})

cmd({
    pattern: "vv2",
    alias: ["vvme", "revealme"],
    desc: "Send a view-once message to your own chat privately. Usage: reply with /vv2",
    category: "convert",
    react: "👁",
    filename: __filename
},
async (conn, mek, m, { quoted, prefix, isOwner, botNumber2, reply }) => {
    try {
        if (!isOwner) return reply(OWNER_ONLY)
        await revealViewOnce(conn, mek, quoted, botNumber2, reply, prefix, 'vv2')
        reply('✅ Sent to your own chat.')
    } catch (e) { console.log(e); reply(friendly(e)) }
})

cmd({
    pattern: "toimg",
    alias: ["stickertoimg", "s2img"],
    desc: "Convert a replied sticker into an image. Usage: reply with /toimg",
    category: "convert",
    react: "🖼",
    filename: __filename
},
async (conn, mek, m, { from, quoted, prefix, sender, reply }) => {
    try {
        const sel = pickMedia(quoted)
        if (!sel || sel.type !== 'stickerMessage') return reply(needReply(prefix, 'toimg', 'a sticker'))
        if (sel.node.isAnimated) return reply('Animated stickers are not supported. Reply to a normal sticker.')
        const wait = cooldown(sender)
        if (wait) return
        await waitReact(conn, from, mek)
        const input = await downloadMedia(sel)
        const image = await withTemp(async (dir) => {
            const inFile = path.join(dir, 'in.webp'), outFile = path.join(dir, 'out.png')
            await fs.promises.writeFile(inFile, input)
            await runFfmpeg(['-y', '-i', inFile, outFile])
            return fs.promises.readFile(outFile)
        })
        await conn.sendMessage(from, { image, caption: 'Here is your image.' }, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})

cmd({
    pattern: "tomp3",
    alias: ["toaudio", "mp3"],
    desc: "Convert a replied video or voice note into an mp3. Usage: reply with /tomp3",
    category: "convert",
    react: "🎵",
    filename: __filename
},
async (conn, mek, m, { from, quoted, prefix, sender, reply }) => {
    try {
        const sel = pickMedia(quoted)
        if (!sel || !['audioMessage', 'videoMessage'].includes(sel.type)) return reply(needReply(prefix, 'tomp3', 'a video or audio message'))
        const wait = cooldown(sender)
        if (wait) return
        await waitReact(conn, from, mek)
        const input = await downloadMedia(sel)
        const audio = await withTemp(async (dir) => {
            const inFile = path.join(dir, 'in'), outFile = path.join(dir, 'out.mp3')
            await fs.promises.writeFile(inFile, input)
            await runFfmpeg(['-y', '-i', inFile, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', outFile])
            return fs.promises.readFile(outFile)
        })
        await conn.sendMessage(from, { audio, mimetype: 'audio/mpeg', fileName: 'audio.mp3' }, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})

cmd({
    pattern: "sticker",
    alias: ["s", "stic"],
    desc: "Make a sticker from a replied image or short video. Usage: reply with /sticker",
    category: "convert",
    react: "✨",
    filename: __filename
},
async (conn, mek, m, { from, quoted, prefix, sender, reply }) => {
    try {
        const sel = pickMedia(quoted)
        if (!sel || !['imageMessage', 'videoMessage'].includes(sel.type)) return reply(needReply(prefix, 'sticker', 'an image or short video'))
        if (sel.type === 'videoMessage' && Number(sel.node.seconds || 0) > 10) return reply('Video is too long. Use a video under 10 seconds.')
        const wait = cooldown(sender)
        if (wait) return
        await waitReact(conn, from, mek)
        const input = await downloadMedia(sel)
        const isVideo = sel.type === 'videoMessage'
        const sticker = await withTemp(async (dir) => {
            const inFile = path.join(dir, 'in'), outFile = path.join(dir, 'out.webp')
            await fs.promises.writeFile(inFile, input)
            const vf = 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
            const args = ['-y', '-i', inFile, '-vf', isVideo ? vf + ',fps=15' : vf]
            if (isVideo) args.push('-t', '8', '-an')
            args.push('-c:v', 'libwebp', '-lossless', '0', '-q:v', '60', '-loop', '0', '-f', 'webp', outFile)
            await runFfmpeg(args)
            return fs.promises.readFile(outFile)
        })
        await conn.sendMessage(from, { sticker }, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})


async function convertMedia(sel, outName, makeArgs) {
    const input = await downloadMedia(sel)
    return withTemp(async (dir) => {
        const inFile = path.join(dir, 'in'), outFile = path.join(dir, outName)
        await fs.promises.writeFile(inFile, input)
        await runFfmpeg(makeArgs(inFile, outFile))
        return fs.promises.readFile(outFile)
    })
}

const npmFont = () => { try { return require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf') } catch (e) { return null } }
const FONT_CANDIDATES = [
    process.env.FONT_PATH,
    path.join(__dirname, '..', 'fonts', 'DejaVuSans-Bold.ttf'),
    npmFont(),
    '/system/fonts/Roboto-Bold.ttf',
    '/system/fonts/Roboto-Regular.ttf',
    '/system/fonts/DroidSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    'C:\\Windows\\Fonts\\arialbd.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
].filter(Boolean)
const findFont = () => FONT_CANDIDATES.find(f => fs.existsSync(f))

const drawtextCache = new Map()
async function hasDrawtext(bin) {
    if (!drawtextCache.has(bin)) {
        drawtextCache.set(bin, runFfmpeg(['-hide_banner', '-filters'], true, undefined, bin)
            .then(out => /\bdrawtext\b/.test(out.toString()))
            .catch(() => false))
    }
    return drawtextCache.get(bin)
}
async function textFfmpeg() {
    for (const bin of [...new Set([FFMPEG, 'ffmpeg'])]) if (await hasDrawtext(bin)) return bin
    return null
}

const MAX_TEXT = 80
function wrapText(text, maxChars = 12) {
    const lines = []
    let line = ''
    for (let word of text.split(/\s+/).filter(Boolean)) {
        while (word.length > maxChars) {
            if (line) { lines.push(line); line = '' }
            lines.push(word.slice(0, maxChars)); word = word.slice(maxChars)
        }
        if (!line) line = word
        else if ((line + ' ' + word).length <= maxChars) line += ' ' + word
        else { lines.push(line); line = word }
    }
    if (line) lines.push(line)
    return lines.slice(0, 8)
}

const RAINBOW = ['FF3B30', 'FF9500', 'FFCC00', '34C759', '00C7BE', '007AFF', 'AF52DE', 'FF2D92']

async function textSticker(text, animated) {
    const font = findFont()
    if (!font) {
        console.log('[TEXT-STICKER] no font found. Run "npm install" or put a .ttf at fonts/DejaVuSans-Bold.ttf (or set FONT_PATH). Tried:\n  ' + FONT_CANDIDATES.join('\n  '))
        throw new Error('NO_FONT')
    }
    const bin = await textFfmpeg()
    if (!bin) {
        console.log('[TEXT-STICKER] this ffmpeg has no "drawtext" filter (' + FFMPEG + '). Install a full ffmpeg on the host or set FFMPEG_PATH.')
        throw new Error('NO_DRAWTEXT')
    }
    const lines = wrapText(text.trim().slice(0, MAX_TEXT))
    if (!lines.length) throw new Error('NO_MEDIA')
    const longest = Math.max(...lines.map(l => l.length))
    const size = Math.max(28, Math.min(170, Math.floor(470 / (longest * 0.72)), Math.floor(470 / (lines.length * 1.3))))

    return withTemp(async (dir) => {
        await fs.promises.copyFile(font, path.join(dir, 'font.ttf'))
        const lh = Math.round(size * 1.25)
        const top = Math.round((512 - lines.length * lh) / 2)
        for (let i = 0; i < lines.length; i++) await fs.promises.writeFile(path.join(dir, `l${i}.txt`), lines[i])
        const draw = (color, extra) => lines.map((_, i) =>
            `drawtext=fontfile=font.ttf:textfile=l${i}.txt:expansion=none:fontsize=${size}:fontcolor=0x${color}:` +
            `x=(w-text_w)/2:y=${top + i * lh}:${extra}`).join(',')

        let vf, args
        if (animated) {
            vf = RAINBOW.map((c, i) => draw(c, `shadowx=3:shadowy=3:shadowcolor=black@0.5:enable='gte(t,${i * 0.25})*lt(t,${(i + 1) * 0.25})'`)).join(',')
            args = ['-y', '-f', 'lavfi', '-i', 'color=c=black@0:s=512x512:r=8:d=2,format=rgba', '-vf', vf,
                '-c:v', 'libwebp', '-lossless', '0', '-q:v', '40', '-compression_level', '6', '-loop', '0', '-an', '-f', 'webp', 'out.webp']
        } else {
            vf = draw('FFFFFF', 'borderw=5:bordercolor=black')
            args = ['-y', '-f', 'lavfi', '-i', 'color=c=black@0:s=512x512:r=1:d=1,format=rgba', '-vf', vf,
                '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '1', '-f', 'webp', 'out.webp']
        }
        await runFfmpeg(args, false, dir, bin)
        return fs.promises.readFile(path.join(dir, 'out.webp'))
    })
}

const textFrom = (q, quoted) => (q || '').trim() ||
    String(quoted?.conversation || quoted?.extendedTextMessage?.text || '').trim()

cmd({
    pattern: "attp",
    alias: ["animtext", "attp2"],
    desc: "Animated colourful text sticker. Usage: /attp <text>",
    category: "convert",
    react: "🌈",
    filename: __filename
},
async (conn, mek, m, { from, q, quoted, prefix, sender, reply }) => {
    try {
        const text = textFrom(q, quoted)
        if (!text) return reply(`Usage: ${prefix}attp <text>`)
        const wait = cooldown(sender)
        if (wait) return
        await waitReact(conn, from, mek)
        const sticker = await textSticker(text, true)
        await conn.sendMessage(from, { sticker }, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})

cmd({
    pattern: "ttp",
    alias: ["texttosticker", "ttp2"],
    desc: "Text to sticker. Usage: /ttp <text>",
    category: "convert",
    react: "🔤",
    filename: __filename
},
async (conn, mek, m, { from, q, quoted, prefix, sender, reply }) => {
    try {
        const text = textFrom(q, quoted)
        if (!text) return reply(`Usage: ${prefix}ttp <text>`)
        const wait = cooldown(sender)
        if (wait) return
        await waitReact(conn, from, mek)
        const sticker = await textSticker(text, false)
        await conn.sendMessage(from, { sticker }, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})

cmd({
    pattern: "ptv",
    alias: ["videonote", "toptv", "vnote"],
    desc: "Convert a replied video into a round video note. Usage: reply with /ptv",
    category: "convert",
    react: "⭕",
    filename: __filename
},
async (conn, mek, m, { from, quoted, prefix, sender, reply }) => {
    try {
        const sel = pickMedia(quoted)
        if (!sel || sel.type !== 'videoMessage') return reply(needReply(prefix, 'ptv', 'a video'))
        if (Number(sel.node.seconds || 0) > 60) return reply('Video is too long. Use a video under 60 seconds.')
        const wait = cooldown(sender)
        if (wait) return
        await waitReact(conn, from, mek)
        const video = await convertMedia(sel, 'out.mp4', (i, o) => [
            '-y', '-i', i, '-t', '60',
            '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale=480:480,format=yuv420p",
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
            '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', o
        ])
        await conn.sendMessage(from, { video, ptv: true, mimetype: 'video/mp4' }, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})

cmd({
    pattern: "togif",
    alias: ["gif", "video2gif", "tovideogif"],
    desc: "Convert a replied video into a looping GIF. Usage: reply with /togif",
    category: "convert",
    react: "🎞",
    filename: __filename
},
async (conn, mek, m, { from, quoted, prefix, sender, reply }) => {
    try {
        const sel = pickMedia(quoted)
        if (!sel || sel.type !== 'videoMessage') return reply(needReply(prefix, 'togif', 'a video'))
        const wait = cooldown(sender)
        if (wait) return
        await waitReact(conn, from, mek)
        const video = await convertMedia(sel, 'out.mp4', (i, o) => [
            '-y', '-i', i, '-t', '10', '-an',
            '-vf', "scale='min(480,iw)':-2,fps=15,format=yuv420p",
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-movflags', '+faststart', o
        ])
        await conn.sendMessage(from, { video, mimetype: 'video/mp4', gifPlayback: true }, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})

cmd({
    pattern: "round",
    alias: ["circle", "circlesticker", "rsticker"],
    desc: "Make a circle sticker from a replied image. Usage: reply with /round",
    category: "convert",
    react: "🔵",
    filename: __filename
},
async (conn, mek, m, { from, quoted, prefix, sender, reply }) => {
    try {
        const sel = pickMedia(quoted)
        if (!sel || !['imageMessage', 'stickerMessage'].includes(sel.type)) return reply(needReply(prefix, 'round', 'an image'))
        if (sel.node.isAnimated) return reply('Animated stickers are not supported. Reply to an image.')
        const wait = cooldown(sender)
        if (wait) return
        await waitReact(conn, from, mek)
        const vf = "scale=512:512:force_original_aspect_ratio=increase,crop=512:512,format=rgba," +
            "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-256,Y-256),255),alpha(X,Y),0)'"
        const sticker = await convertMedia(sel, 'out.webp', (i, o) => [
            '-y', '-i', i, '-vf', vf, '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '70', '-f', 'webp', o
        ])
        await conn.sendMessage(from, { sticker }, { quoted: mek })
    } catch (e) { console.log(e); reply(friendly(e)) }
})

function audioEffect({ pattern, alias, desc, react, filter }) {
    cmd({ pattern, alias, desc, category: "convert", react, filename: __filename },
    async (conn, mek, m, { from, quoted, prefix, sender, reply }) => {
        try {
            const sel = pickMedia(quoted)
            if (!sel || !['audioMessage', 'videoMessage'].includes(sel.type)) return reply(needReply(prefix, pattern, 'an audio or video message'))
            const wait = cooldown(sender)
            if (wait) return
            await waitReact(conn, from, mek)
            const audio = await convertMedia(sel, 'out.mp3', (i, o) => [
                '-y', '-i', i, '-vn', '-af', filter, '-c:a', 'libmp3lame', '-b:a', '128k', o
            ])
            await conn.sendMessage(from, { audio, mimetype: 'audio/mpeg', fileName: `${pattern}.mp3` }, { quoted: mek })
        } catch (e) { console.log(e); reply(friendly(e)) }
    })
}

audioEffect({ pattern: "bass", alias: ["bassboost"], react: "🔊", desc: "Boost the bass of a replied audio. Usage: reply with /bass",
    filter: 'bass=g=16:f=100:w=0.6,alimiter=limit=0.9' })
audioEffect({ pattern: "nightcore", alias: ["nc"], react: "⚡", desc: "Faster, higher-pitched audio. Usage: reply with /nightcore",
    filter: 'aresample=44100,asetrate=55125,aresample=44100' })
audioEffect({ pattern: "slow", alias: ["slowed", "slowmo"], react: "🐢", desc: "Slowed, lower-pitched audio. Usage: reply with /slow",
    filter: 'aresample=44100,asetrate=35280,aresample=44100' })
audioEffect({ pattern: "fast", alias: ["speedup", "speed2x"], react: "🐇", desc: "Speed up audio without changing the pitch. Usage: reply with /fast",
    filter: 'atempo=1.5' })
audioEffect({ pattern: "echo", alias: ["reverb"], react: "🏔", desc: "Add an echo to a replied audio. Usage: reply with /echo",
    filter: 'aecho=0.8:0.88:60|600:0.4|0.3' })

cmd({
    pattern: "reverse",
    alias: ["rev", "backwards"],
    desc: "Play a replied audio or video backwards. Usage: reply with /reverse",
    category: "convert",
    react: "⏪",
    filename: __filename
},
async (conn, mek, m, { from, quoted, prefix, sender, reply }) => {
    try {
        const sel = pickMedia(quoted)
        if (!sel || !['audioMessage', 'videoMessage'].includes(sel.type)) return reply(needReply(prefix, 'reverse', 'an audio or video message'))
        if (Number(sel.node.seconds || 0) > 30) return reply('That is too long. Use something under 30 seconds.')
        const wait = cooldown(sender)
        if (wait) return
        await waitReact(conn, from, mek)
        if (sel.type === 'audioMessage') {
            const audio = await convertMedia(sel, 'out.mp3', (i, o) => ['-y', '-i', i, '-t', '30', '-vn', '-af', 'areverse', '-c:a', 'libmp3lame', '-b:a', '128k', o])
            await conn.sendMessage(from, { audio, mimetype: 'audio/mpeg', fileName: 'reverse.mp3' }, { quoted: mek })
        } else {
            const video = await convertMedia(sel, 'out.mp4', (i, o) => [
                '-y', '-i', i, '-t', '30',
                '-vf', "scale='min(480,iw)':-2,reverse,format=yuv420p", '-af', 'areverse',
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', o
            ])
            await conn.sendMessage(from, { video, mimetype: 'video/mp4' }, { quoted: mek })
        }
    } catch (e) { console.log(e); reply(friendly(e)) }
})

const fancyFonts = (function () {
    const module = { exports: {} }
function apply(map, text) {
    let result = ""; for (let character of text.split("")) { if (map[character] !== undefined) result += map[character]; else if (map[character.toLowerCase()] !== undefined) result += map[character.toLowerCase()]; else result += character }
    return result
}
function list(text, fancy) {
    let styles = (Object.keys(fancy)).filter(e => e.length < 3)
    let msg = '\n*Numeric codes:*\n\n'
    for (let style in styles) {
        if (style == 33) {
            msg += '`'+ (parseInt(style) + 1) + '.` ' + 'Malayalam font' + '\n'
        } else {
            msg += '`'+ (parseInt(style) + 1) + '.` ' + fancy.apply(fancy[parseInt(style)], text) + '\n'
        }
    }
    return msg
} 
module.exports = {
    0:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"ค","b":"๖","c":"¢","d":"໓","e":"ē","f":"f","g":"ງ","h":"h","i":"i","j":"ว","k":"k","l":"l","m":"๓","n":"ຖ","o":"໐","p":"p","q":"๑","r":"r","s":"Ş","t":"t","u":"น","v":"ง","w":"ຟ","x":"x","y":"ฯ","z":"ຊ","A":"ค","B":"๖","C":"¢","D":"໓","E":"ē","F":"f","G":"ງ","H":"h","I":"i","J":"ว","K":"k","L":"l","M":"๓","N":"ຖ","O":"໐","P":"p","Q":"๑","R":"r","S":"Ş","T":"t","U":"น","V":"ง","W":"ຟ","X":"x","Y":"ฯ","Z":"ຊ" },
    1:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"ą","b":"ც","c":"ƈ","d":"ɖ","e":"ɛ","f":"ʄ","g":"ɠ","h":"ɧ","i":"ı","j":"ʝ","k":"ƙ","l":"Ɩ","m":"ɱ","n":"ŋ","o":"ơ","p":"℘","q":"զ","r":"ཞ","s":"ʂ","t":"ɬ","u":"ų","v":"۷","w":"ῳ","x":"ҳ","y":"ყ","z":"ʑ","A":"ą","B":"ც","C":"ƈ","D":"ɖ","E":"ɛ","F":"ʄ","G":"ɠ","H":"ɧ","I":"ı","J":"ʝ","K":"ƙ","L":"Ɩ","M":"ɱ","N":"ŋ","O":"ơ","P":"℘","Q":"զ","R":"ཞ","S":"ʂ","T":"ɬ","U":"ų","V":"۷","W":"ῳ","X":"ҳ","Y":"ყ","Z":"ʑ" },
    2:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"ﾑ","b":"乃","c":"ᄃ","d":"り","e":"乇","f":"ｷ","g":"ム","h":"ん","i":"ﾉ","j":"ﾌ","k":"ズ","l":"ﾚ","m":"ﾶ","n":"刀","o":"の","p":"ｱ","q":"ゐ","r":"尺","s":"丂","t":"ｲ","u":"ひ","v":"√","w":"W","x":"ﾒ","y":"ﾘ","z":"乙","A":"ﾑ","B":"乃","C":"ᄃ","D":"り","E":"乇","F":"ｷ","G":"ム","H":"ん","I":"ﾉ","J":"ﾌ","K":"ズ","L":"ﾚ","M":"ﾶ","N":"刀","O":"の","P":"ｱ","Q":"ゐ","R":"尺","S":"丂","T":"ｲ","U":"ひ","V":"√","W":"W","X":"ﾒ","Y":"ﾘ","Z":"乙" },
    3:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"卂","b":"乃","c":"匚","d":"ᗪ","e":"乇","f":"千","g":"Ꮆ","h":"卄","i":"丨","j":"ﾌ","k":"Ҝ","l":"ㄥ","m":"爪","n":"几","o":"ㄖ","p":"卩","q":"Ɋ","r":"尺","s":"丂","t":"ㄒ","u":"ㄩ","v":"ᐯ","w":"山","x":"乂","y":"ㄚ","z":"乙","A":"卂","B":"乃","C":"匚","D":"ᗪ","E":"乇","F":"千","G":"Ꮆ","H":"卄","I":"丨","J":"ﾌ","K":"Ҝ","L":"ㄥ","M":"爪","N":"几","O":"ㄖ","P":"卩","Q":"Ɋ","R":"尺","S":"丂","T":"ㄒ","U":"ㄩ","V":"ᐯ","W":"山","X":"乂","Y":"ㄚ","Z":"乙" },
    4:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"🄰","b":"🄱","c":"🄲","d":"🄳","e":"🄴","f":"🄵","g":"🄶","h":"🄷","i":"🄸","j":"🄹","k":"🄺","l":"🄻","m":"🄼","n":"🄽","o":"🄾","p":"🄿","q":"🅀","r":"🅁","s":"🅂","t":"🅃","u":"🅄","v":"🅅","w":"🅆","x":"🅇","y":"🅈","z":"🅉","A":"🄰","B":"🄱","C":"🄲","D":"🄳","E":"🄴","F":"🄵","G":"🄶","H":"🄷","I":"🄸","J":"🄹","K":"🄺","L":"🄻","M":"🄼","N":"🄽","O":"🄾","P":"🄿","Q":"🅀","R":"🅁","S":"🅂","T":"🅃","U":"🅄","V":"🅅","W":"🅆","X":"🅇","Y":"🅈","Z":"🅉" },
    5:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"Ꮧ","b":"Ᏸ","c":"ፈ","d":"Ꮄ","e":"Ꮛ","f":"Ꭶ","g":"Ꮆ","h":"Ꮒ","i":"Ꭵ","j":"Ꮰ","k":"Ꮶ","l":"Ꮭ","m":"Ꮇ","n":"Ꮑ","o":"Ꭷ","p":"Ꭾ","q":"Ꭴ","r":"Ꮢ","s":"Ꮥ","t":"Ꮦ","u":"Ꮼ","v":"Ꮙ","w":"Ꮗ","x":"ጀ","y":"Ꭹ","z":"ፚ","A":"Ꮧ","B":"Ᏸ","C":"ፈ","D":"Ꮄ","E":"Ꮛ","F":"Ꭶ","G":"Ꮆ","H":"Ꮒ","I":"Ꭵ","J":"Ꮰ","K":"Ꮶ","L":"Ꮭ","M":"Ꮇ","N":"Ꮑ","O":"Ꭷ","P":"Ꭾ","Q":"Ꭴ","R":"Ꮢ","S":"Ꮥ","T":"Ꮦ","U":"Ꮼ","V":"Ꮙ","W":"Ꮗ","X":"ጀ","Y":"Ꭹ","Z":"ፚ" },
    6:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"ᗩ","b":"ᗷ","c":"ᑕ","d":"ᗪ","e":"E","f":"ᖴ","g":"G","h":"ᕼ","i":"I","j":"ᒍ","k":"K","l":"ᒪ","m":"ᗰ","n":"ᑎ","o":"O","p":"ᑭ","q":"ᑫ","r":"ᖇ","s":"ᔕ","t":"T","u":"ᑌ","v":"ᐯ","w":"ᗯ","x":"᙭","y":"Y","z":"ᘔ","A":"ᗩ","B":"ᗷ","C":"ᑕ","D":"ᗪ","E":"E","F":"ᖴ","G":"G","H":"ᕼ","I":"I","J":"ᒍ","K":"K","L":"ᒪ","M":"ᗰ","N":"ᑎ","O":"O","P":"ᑭ","Q":"ᑫ","R":"ᖇ","S":"ᔕ","T":"T","U":"ᑌ","V":"ᐯ","W":"ᗯ","X":"᙭","Y":"Y","Z":"ᘔ" },
    7:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"ǟ","b":"ɮ","c":"ƈ","d":"ɖ","e":"ɛ","f":"ʄ","g":"ɢ","h":"ɦ","i":"ɨ","j":"ʝ","k":"ӄ","l":"ʟ","m":"ʍ","n":"ռ","o":"օ","p":"ք","q":"զ","r":"ʀ","s":"ֆ","t":"ȶ","u":"ʊ","v":"ʋ","w":"ա","x":"Ӽ","y":"ʏ","z":"ʐ","A":"ǟ","B":"ɮ","C":"ƈ","D":"ɖ","E":"ɛ","F":"ʄ","G":"ɢ","H":"ɦ","I":"ɨ","J":"ʝ","K":"ӄ","L":"ʟ","M":"ʍ","N":"ռ","O":"օ","P":"ք","Q":"զ","R":"ʀ","S":"ֆ","T":"ȶ","U":"ʊ","V":"ʋ","W":"ա","X":"Ӽ","Y":"ʏ","Z":"ʐ" },
    8:{"0":"𝟶","1":"𝟷","2":"𝟸","3":"𝟹","4":"𝟺","5":"𝟻","6":"𝟼","7":"𝟽","8":"𝟾","9":"𝟿","a":"𝚊","b":"𝚋","c":"𝚌","d":"𝚍","e":"𝚎","f":"𝚏","g":"𝚐","h":"𝚑","i":"𝚒","j":"𝚓","k":"𝚔","l":"𝚕","m":"𝚖","n":"𝚗","o":"𝚘","p":"𝚙","q":"𝚚","r":"𝚛","s":"𝚜","t":"𝚝","u":"𝚞","v":"𝚟","w":"𝚠","x":"𝚡","y":"𝚢","z":"𝚣","A":"𝙰","B":"𝙱","C":"𝙲","D":"𝙳","E":"𝙴","F":"𝙵","G":"𝙶","H":"𝙷","I":"𝙸","J":"𝙹","K":"𝙺","L":"𝙻","M":"𝙼","N":"𝙽","O":"𝙾","P":"𝙿","Q":"𝚀","R":"𝚁","S":"𝚂","T":"𝚃","U":"𝚄","V":"𝚅","W":"𝚆","X":"𝚇","Y":"𝚈","Z":"𝚉" },
    9:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"𝙖","b":"𝙗","c":"𝙘","d":"𝙙","e":"𝙚","f":"𝙛","g":"𝙜","h":"𝙝","i":"𝙞","j":"𝙟","k":"𝙠","l":"𝙡","m":"𝙢","n":"𝙣","o":"𝙤","p":"𝙥","q":"𝙦","r":"𝙧","s":"𝙨","t":"𝙩","u":"𝙪","v":"𝙫","w":"𝙬","x":"𝙭","y":"𝙮","z":"𝙯","A":"𝘼","B":"𝘽","C":"𝘾","D":"𝘿","E":"𝙀","F":"𝙁","G":"𝙂","H":"𝙃","I":"𝙄","J":"𝙅","K":"𝙆","L":"𝙇","M":"𝙈","N":"𝙉","O":"𝙊","P":"𝙋","Q":"𝙌","R":"𝙍","S":"𝙎","T":"𝙏","U":"𝙐","V":"𝙑","W":"𝙒","X":"𝙓","Y":"𝙔","Z":"𝙕" },
    10:{"0":"𝟎","1":"𝟏","2":"𝟐","3":"𝟑","4":"𝟒","5":"𝟓","6":"𝟔","7":"𝟕","8":"𝟖","9":"𝟗","a":"𝐚","b":"𝐛","c":"𝐜","d":"𝐝","e":"𝐞","f":"𝐟","g":"𝐠","h":"𝐡","i":"𝐢","j":"𝐣","k":"𝐤","l":"𝐥","m":"𝐦","n":"𝐧","o":"𝐨","p":"𝐩","q":"𝐪","r":"𝐫","s":"𝐬","t":"𝐭","u":"𝐮","v":"𝐯","w":"𝐰","x":"𝐱","y":"𝐲","z":"𝐳","A":"𝐀","B":"𝐁","C":"𝐂","D":"𝐃","E":"𝐄","F":"𝐅","G":"𝐆","H":"𝐇","I":"𝐈","J":"𝐉","K":"𝐊","L":"𝐋","M":"𝐌","N":"𝐍","O":"𝐎","P":"𝐏","Q":"𝐐","R":"𝐑","S":"𝐒","T":"𝐓","U":"𝐔","V":"𝐕","W":"𝐖","X":"𝐗","Y":"𝐘","Z":"𝐙" },
    11:{"0":"𝟬","1":"𝟭","2":"𝟮","3":"𝟯","4":"𝟰","5":"𝟱","6":"𝟲","7":"𝟳","8":"𝟴","9":"𝟵","a":"𝗮","b":"𝗯","c":"𝗰","d":"𝗱","e":"𝗲","f":"𝗳","g":"𝗴","h":"𝗵","i":"𝗶","j":"𝗷","k":"𝗸","l":"𝗹","m":"𝗺","n":"𝗻","o":"𝗼","p":"𝗽","q":"𝗾","r":"𝗿","s":"𝘀","t":"𝘁","u":"𝘂","v":"𝘃","w":"𝘄","x":"𝘅","y":"𝘆","z":"𝘇","A":"𝗔","B":"𝗕","C":"𝗖","D":"𝗗","E":"𝗘","F":"𝗙","G":"𝗚","H":"𝗛","I":"𝗜","J":"𝗝","K":"𝗞","L":"𝗟","M":"𝗠","N":"𝗡","O":"𝗢","P":"𝗣","Q":"𝗤","R":"𝗥","S":"𝗦","T":"𝗧","U":"𝗨","V":"𝗩","W":"𝗪","X":"𝗫","Y":"𝗬","Z":"𝗭" },
    12: {"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"𝘢","b":"𝘣","c":"𝘤","d":"𝘥","e":"𝘦","f":"𝘧","g":"𝘨","h":"𝘩","i":"𝘪","j":"𝘫","k":"𝘬","l":"𝘭","m":"𝘮","n":"𝘯","o":"𝘰","p":"𝘱","q":"𝘲","r":"𝘳","s":"𝘴","t":"𝘵","u":"𝘶","v":"𝘷","w":"𝘸","x":"𝘹","y":"𝘺","z":"𝘻","A":"𝘈","B":"𝘉","C":"𝘊","D":"𝘋","E":"𝘌","F":"𝘍","G":"𝘎","H":"𝘏","I":"𝘐","J":"𝘑","K":"𝘒","L":"𝘓","M":"𝘔","N":"𝘕","O":"𝘖","P":"𝘗","Q":"𝘘","R":"𝘙","S":"𝘚","T":"𝘛","U":"𝘜","V":"𝘝","W":"𝘞","X":"𝘟","Y":"𝘠","Z":"𝘡" },
    13:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"α","b":"Ⴆ","c":"ƈ","d":"ԃ","e":"ҽ","f":"ϝ","g":"ɠ","h":"ԋ","i":"ι","j":"ʝ","k":"ƙ","l":"ʅ","m":"ɱ","n":"ɳ","o":"σ","p":"ρ","q":"ϙ","r":"ɾ","s":"ʂ","t":"ƚ","u":"υ","v":"ʋ","w":"ɯ","x":"x","y":"ყ","z":"ȥ","A":"A","B":"B","C":"C","D":"D","E":"E","F":"F","G":"G","H":"H","I":"I","J":"J","K":"K","L":"L","M":"M","N":"N","O":"O","P":"P","Q":"Q","R":"R","S":"S","T":"T","U":"U","V":"V","W":"W","X":"X","Y":"Y","Z":"Z" },
    14:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"₳","b":"฿","c":"₵","d":"Đ","e":"Ɇ","f":"₣","g":"₲","h":"Ⱨ","i":"ł","j":"J","k":"₭","l":"Ⱡ","m":"₥","n":"₦","o":"Ø","p":"₱","q":"Q","r":"Ɽ","s":"₴","t":"₮","u":"Ʉ","v":"V","w":"₩","x":"Ӿ","y":"Ɏ","z":"Ⱬ","A":"₳","B":"฿","C":"₵","D":"Đ","E":"Ɇ","F":"₣","G":"₲","H":"Ⱨ","I":"ł","J":"J","K":"₭","L":"Ⱡ","M":"₥","N":"₦","O":"Ø","P":"₱","Q":"Q","R":"Ɽ","S":"₴","T":"₮","U":"Ʉ","V":"V","W":"₩","X":"Ӿ","Y":"Ɏ","Z":"Ⱬ" },
    15:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"å","b":"ß","c":"¢","d":"Ð","e":"ê","f":"£","g":"g","h":"h","i":"ï","j":"j","k":"k","l":"l","m":"m","n":"ñ","o":"ð","p":"þ","q":"q","r":"r","s":"§","t":"†","u":"µ","v":"v","w":"w","x":"x","y":"¥","z":"z","A":"Ä","B":"ß","C":"Ç","D":"Ð","E":"È","F":"£","G":"G","H":"H","I":"Ì","J":"J","K":"K","L":"L","M":"M","N":"ñ","O":"Ö","P":"þ","Q":"Q","R":"R","S":"§","T":"†","U":"Ú","V":"V","W":"W","X":"×","Y":"¥","Z":"Z" },
    16:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"α","b":"в","c":"¢","d":"∂","e":"є","f":"ƒ","g":"g","h":"н","i":"ι","j":"נ","k":"к","l":"ℓ","m":"м","n":"η","o":"σ","p":"ρ","q":"q","r":"я","s":"ѕ","t":"т","u":"υ","v":"ν","w":"ω","x":"χ","y":"у","z":"z","A":"α","B":"в","C":"¢","D":"∂","E":"є","F":"ƒ","G":"g","H":"н","I":"ι","J":"נ","K":"к","L":"ℓ","M":"м","N":"η","O":"σ","P":"ρ","Q":"q","R":"я","S":"ѕ","T":"т","U":"υ","V":"ν","W":"ω","X":"χ","Y":"у","Z":"z" },
    17:{"0":"⊘","1":"𝟙","2":"ϩ","3":"Ӡ","4":"५","5":"Ƽ","6":"Ϭ","7":"7","8":"𝟠","9":"९","a":"ą","b":"ҍ","c":"ç","d":"ժ","e":"ҽ","f":"ƒ","g":"ց","h":"հ","i":"ì","j":"ʝ","k":"ҟ","l":"Ӏ","m":"ʍ","n":"ղ","o":"օ","p":"ք","q":"զ","r":"ɾ","s":"ʂ","t":"է","u":"մ","v":"ѵ","w":"ա","x":"×","y":"վ","z":"Հ","A":"Ⱥ","B":"β","C":"↻","D":"Ꭰ","E":"Ɛ","F":"Ƒ","G":"Ɠ","H":"Ƕ","I":"į","J":"ل","K":"Ҡ","L":"Ꝉ","M":"Ɱ","N":"ហ","O":"ට","P":"φ","Q":"Ҩ","R":"འ","S":"Ϛ","T":"Ͳ","U":"Ա","V":"Ỽ","W":"చ","X":"ჯ","Y":"Ӌ","Z":"ɀ" },
    18:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"Λ","b":"B","c":"ᄃ","d":"D","e":"Σ","f":"F","g":"G","h":"Ή","i":"I","j":"J","k":"K","l":"ᄂ","m":"M","n":"П","o":"Ө","p":"P","q":"Q","r":"Я","s":"Ƨ","t":"Ƭ","u":"Ц","v":"V","w":"Щ","x":"X","y":"Y","z":"Z","A":"Λ","B":"B","C":"ᄃ","D":"D","E":"Σ","F":"F","G":"G","H":"Ή","I":"I","J":"J","K":"K","L":"ᄂ","M":"M","N":"П","O":"Ө","P":"P","Q":"Q","R":"Я","S":"Ƨ","T":"Ƭ","U":"Ц","V":"V","W":"Щ","X":"X","Y":"Y","Z":"Z" },
    19:{"0":"₀","1":"₁","2":"₂","3":"₃","4":"₄","5":"₅","6":"₆","7":"₇","8":"₈","9":"₉","a":"ₐ","b":"b","c":"c","d":"d","e":"ₑ","f":"f","g":"g","h":"ₕ","i":"ᵢ","j":"ⱼ","k":"ₖ","l":"ₗ","m":"ₘ","n":"ₙ","o":"ₒ","p":"ₚ","q":"q","r":"ᵣ","s":"ₛ","t":"ₜ","u":"ᵤ","v":"ᵥ","w":"w","x":"ₓ","y":"y","z":"z","A":"ₐ","B":"B","C":"C","D":"D","E":"ₑ","F":"F","G":"G","H":"ₕ","I":"ᵢ","J":"ⱼ","K":"ₖ","L":"ₗ","M":"ₘ","N":"ₙ","O":"ₒ","P":"ₚ","Q":"Q","R":"ᵣ","S":"ₛ","T":"ₜ","U":"ᵤ","V":"ᵥ","W":"W","X":"ₓ","Y":"Y","Z":"Z","+":"₊","-":"₋",":":"₌","(":"₍",")":"₎" },
    20:{"0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹","a":"ᵃ","b":"ᵇ","c":"ᶜ","d":"ᵈ","e":"ᵉ","f":"ᶠ","g":"ᵍ","h":"ʰ","i":"ⁱ","j":"ʲ","k":"ᵏ","l":"ˡ","m":"ᵐ","n":"ⁿ","o":"ᵒ","p":"ᵖ","q":"q","r":"ʳ","s":"ˢ","t":"ᵗ","u":"ᵘ","v":"ᵛ","w":"ʷ","x":"ˣ","y":"ʸ","z":"ᶻ","A":"ᴬ","B":"ᴮ","C":"ᶜ","D":"ᴰ","E":"ᴱ","F":"ᶠ","G":"ᴳ","H":"ᴴ","I":"ᴵ","J":"ᴶ","K":"ᴷ","L":"ᴸ","M":"ᴹ","N":"ᴺ","O":"ᴼ","P":"ᴾ","Q":"Q","R":"ᴿ","S":"ˢ","T":"ᵀ","U":"ᵁ","V":"ⱽ","W":"ᵂ","X":"ˣ","Y":"ʸ","Z":"ᶻ","+":"⁺","-":"⁻",":":"⁼","(":"⁽",")":"⁾" },
    21:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"ค","b":"๒","c":"ς","d":"๔","e":"є","f":"Ŧ","g":"ﻮ","h":"ђ","i":"เ","j":"ן","k":"к","l":"ɭ","m":"๓","n":"ภ","o":"๏","p":"ק","q":"ợ","r":"г","s":"ร","t":"Շ","u":"ย","v":"ש","w":"ฬ","x":"א","y":"ץ","z":"չ","A":"ค","B":"๒","C":"ς","D":"๔","E":"є","F":"Ŧ","G":"ﻮ","H":"ђ","I":"เ","J":"ן","K":"к","L":"ɭ","M":"๓","N":"ภ","O":"๏","P":"ק","Q":"ợ","R":"г","S":"ร","T":"Շ","U":"ย","V":"ש","W":"ฬ","X":"א","Y":"ץ","Z":"չ" },
    22:{"0":"𝟘","1":"𝟙","2":"𝟚","3":"𝟛","4":"𝟜","5":"𝟝","6":"𝟞","7":"𝟟","8":"𝟠","9":"𝟡","a":"𝕒","b":"𝕓","c":"𝕔","d":"𝕕","e":"𝕖","f":"𝕗","g":"𝕘","h":"𝕙","i":"𝕚","j":"𝕛","k":"𝕜","l":"𝕝","m":"𝕞","n":"𝕟","o":"𝕠","p":"𝕡","q":"𝕢","r":"𝕣","s":"𝕤","t":"𝕥","u":"𝕦","v":"𝕧","w":"𝕨","x":"𝕩","y":"𝕪","z":"𝕫","A":"𝔸","B":"𝔹","C":"ℂ","D":"𝔻","E":"𝔼","F":"𝔽","G":"𝔾","H":"ℍ","I":"𝕀","J":"𝕁","K":"𝕂","L":"𝕃","M":"𝕄","N":"ℕ","O":"𝕆","P":"ℙ","Q":"ℚ","R":"ℝ","S":"𝕊","T":"𝕋","U":"𝕌","V":"𝕍","W":"𝕎","X":"𝕏","Y":"𝕐","Z":"ℤ" },
    23:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"𝖆","b":"𝖇","c":"𝖈","d":"𝖉","e":"𝖊","f":"𝖋","g":"𝖌","h":"𝖍","i":"𝖎","j":"𝖏","k":"𝖐","l":"𝖑","m":"𝖒","n":"𝖓","o":"𝖔","p":"𝖕","q":"𝖖","r":"𝖗","s":"𝖘","t":"𝖙","u":"𝖚","v":"𝖛","w":"𝖜","x":"𝖝","y":"𝖞","z":"𝖟","A":"𝕬","B":"𝕭","C":"𝕮","D":"𝕯","E":"𝕰","F":"𝕱","G":"𝕲","H":"𝕳","I":"𝕴","J":"𝕵","K":"𝕶","L":"𝕷","M":"𝕸","N":"𝕹","O":"𝕺","P":"𝕻","Q":"𝕼","R":"𝕽","S":"𝕾","T":"𝕿","U":"𝖀","V":"𝖁","W":"𝖂","X":"𝖃","Y":"𝖄","Z":"𝖅" },
    24:{q:"🆀",w:"🆆",e:"🅴",r:"🆁",t:"🆃",y:"🆈",u:"🆄",i:"🅸",o:"🅾",p:"🅿",a:"🅰",s:"🆂",d:"🅳",f:"🅵",g:"🅶",h:"🅷",j:"🅹",k:"🅺",l:"🅻",z:"🆉",x:"🆇",c:"🅲",v:"🆅",b:"🅱",n:"🅽",m:"🅼"}, 
    25:{"0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9","a":"𝓪","b":"𝓫","c":"𝓬","d":"𝓭","e":"𝓮","f":"𝓯","g":"𝓰","h":"𝓱","i":"𝓲","j":"𝓳","k":"𝓴","l":"𝓵","m":"𝓶","n":"𝓷","o":"𝓸","p":"𝓹","q":"𝓺","r":"𝓻","s":"𝓼","t":"𝓽","u":"𝓾","v":"𝓿","w":"𝔀","x":"𝔁","y":"𝔂","z":"𝔃","A":"𝓐","B":"𝓑","C":"𝓒","D":"𝓓","E":"𝓔","F":"𝓕","G":"𝓖","H":"𝓗","I":"𝓘","J":"𝓙","K":"𝓚","L":"𝓛","M":"𝓜","N":"𝓝","O":"𝓞","P":"𝓟","Q":"𝓠","R":"𝓡","S":"𝓢","T":"𝓣","U":"𝓤","V":"𝓥","W":"𝓦","X":"𝓧","Y":"𝓨","Z":"𝓩" },
    26:{"a":"𝔞","b":"𝔟","c":"𝔠","d":"𝔡","e":"𝔢","f":"𝔣","g":"𝔤","h":"𝔥","i":"𝔦","j":"𝔧","k":"𝔨","l":"𝔩","m":"𝔪","n":"𝔫","o":"𝔬","p":"𝔭","q":"𝔮","r":"𝔯","s":"𝔰","t":"𝔱","u":"𝔲","v":"𝔳","w":"𝔴","x":"𝔵","y":"𝔶","z":"𝔷","A":"𝔄","B":"𝔅","C":"ℭ","D":"𝔇","E":"𝔈","F":"𝔉","G":"𝔊","H":"ℌ","I":"ℑ","J":"𝔍","K":"𝔎","L":"𝔏","M":"𝔐","N":"𝔑","O":"𝔒","P":"𝔓","Q":"𝔔","R":"ℜ","S":"𝔖","T":"𝔗","U":"𝔘","V":"𝔙","W":"𝔚","X":"𝔛","Y":"𝔜","Z":"ℨ" },
    27:{"`":"`","1":"１","2":"２","3":"３","4":"４","5":"５","6":"６","7":"７","8":"８","9":"９","0":"０","-":"－",":":"＝","~":"~","!":"！","@":"＠","#":"＃","$":"＄","%":"％","^":"^","&":"＆","*":"＊","(":"（",")":"）","_":"_","+":"＋","q":"ｑ","w":"ｗ","e":"ｅ","r":"ｒ","t":"ｔ","y":"ｙ","u":"ｕ","i":"ｉ","o":"ｏ","p":"ｐ","[":"[","]":"]","\\":"\\","Q":"Ｑ","W":"Ｗ","E":"Ｅ","R":"Ｒ","T":"Ｔ","Y":"Ｙ","U":"Ｕ","I":"Ｉ","O":"Ｏ","P":"Ｐ","{":"{","}":"}","|":"|","a":"ａ","s":"ｓ","d":"ｄ","f":"ｆ","g":"ｇ","h":"ｈ","j":"ｊ","k":"ｋ","l":"ｌ",";":"；","'":"＇","A":"Ａ","S":"Ｓ","D":"Ｄ","F":"Ｆ","G":"Ｇ","H":"Ｈ","J":"Ｊ","K":"Ｋ","L":"Ｌ",":":"：","\"":"\"","z":"ｚ","x":"ｘ","c":"ｃ","v":"ｖ","b":"ｂ","n":"ｎ","m":"ｍ",",":"，",".":"．","/":"／","Z":"Ｚ","X":"Ｘ","C":"Ｃ","V":"Ｖ","B":"Ｂ","N":"Ｎ","M":"Ｍ","<":"<",">":">","?":"？"},
    28:{"a":"ᴀ","b":"ʙ","c":"ᴄ","d":"ᴅ","e":"ᴇ","f":"ғ","g":"ɢ","h":"ʜ","i":"ɪ","j":"ᴊ","k":"ᴋ","l":"ʟ","m":"ᴍ","n":"ɴ","o":"ᴏ","p":"ᴘ","q":"ǫ","r":"ʀ","s":"s","t":"ᴛ","u":"ᴜ","v":"ᴠ","w":"ᴡ","x":"x","y":"ʏ","z":"ᴢ","A":"ᴀ","B":"ʙ","C":"ᴄ","D":"ᴅ","E":"ᴇ","F":"ғ","G":"ɢ","H":"ʜ","I":"ɪ","J":"ᴊ","K":"ᴋ","L":"ʟ","M":"ᴍ","N":"ɴ","O":"ᴏ","P":"ᴘ","Q":"ǫ","R":"ʀ","S":"s","T":"ᴛ","U":"ᴜ","V":"ᴠ","W":"ᴡ","X":"x","Y":"ʏ","Z":"ᴢ" },
    29:{"a":"𝒂","b":"𝒃","c":"𝒄","d":"𝒅","e":"𝒆","f":"𝒇","g":"𝒈","h":"𝒉","i":"𝒊","j":"𝒋","k":"𝒌","l":"𝒍","m":"𝒎","n":"𝒏","o":"𝒐","p":"𝒑","q":"𝒒","r":"𝒓","s":"𝒔","t":"𝒕","u":"𝒖","v":"𝒗","w":"𝒘","x":"𝒙","y":"𝒚","z":"𝒛","A":"𝐴","B":"𝐵","C":"𝐶","D":"𝐷","E":"𝐸","F":"𝐹","G":"𝐺","H":"𝐻","I":"𝐼","J":"𝐽","K":"𝐾","L":"𝐿","M":"𝑀","N":"𝑁","O":"𝑂","P":"𝑃","Q":"𝑄","R":"𝑅","S":"𝑆","T":"𝑇","U":"𝑈","V":"𝑉","W":"𝑊","X":"𝑋","Y":"𝑌","Z":"𝑍" },
    30:{"a":"𝛥","b":"𝐵","c":"𝐶","d":"𝐷","e":"𝛯","f":"𝐹","g":"𝐺","h":"𝛨","i":"𝛪","j":"𝐽","k":"𝛫","l":"𝐿","m":"𝛭","n":"𝛮","o":"𝛩","p":"𝛲","q":"𝑄","r":"𝑅","s":"𝑆","t":"𝑇","u":"𝑈","v":"𝛻","w":"𝑊","x":"𝛸","y":"𝑌","z":"𝛧","A":"𝛥","B":"𝐵","C":"𝐶","D":"𝐷","E":"𝛯","F":"𝐹","G":"𝐺","H":"𝛨","I":"𝛪","J":"𝐽","K":"𝛫","L":"𝐿","M":"𝛭","N":"𝛮","O":"𝛩","P":"𝛲","Q":"𝑄","R":"𝑅","S":"𝑆","T":"𝑇","U":"𝑈","V":"𝛻","W":"𝑊","X":"𝛸","Y":"𝑌","Z":"𝛧"},
    31:{"A":"𝚫","B":"𝚩","C":"𝐂","D":"𝐃","E":"𝚵","F":"𝐅","G":"𝐆","H":"𝚮","I":"𝚰","J":"𝐉","K":"𝐊","L":"𝐋","M":"𝚳","N":"𝚴","O":"𝚯","P":"𝚸","Q":"𝐐","R":"𝚪","S":"𝐒","T":"𝚻","U":"𝐔","V":"𝛁","W":"𝐖","X":"𝚾","Y":"𝐘","Z":"𝚭","a":"𝚫","b":"𝚩","c":"𝐂","d":"𝐃","e":"𝚵","f":"𝐅","g":"𝐆","h":"𝚮","i":"𝚰","j":"𝐉","k":"𝐊","l":"𝐋","m":"𝚳","n":"𝚴","o":"𝚯","p":"𝚸","q":"𝐐","r":"𝚪","s":"𝐒","t":"𝚻","u":"𝐔","v":"𝛁","w":"𝐖","x":"𝚾","y":"𝐘","z":"𝚭"},	
    32:{"A":"ꪖ","B":"᥇","C":"ᥴ","D":"ᦔ","E":"ꫀ","F":"ᠻ","G":"ᧁ","H":"ꫝ","I":"ﺃ","J":"꠹","K":"ᛕ","L":"ꪶ","M":"ꪑ","N":"ꪀ","O":"ꪮ","P":"ᜣ","Q":"ꪇ","R":"᥅","S":"ᦓ","T":"ꪻ","U":"ꪊ","V":"ꪜ","W":"᭙","X":"᥊","Y":"ꪗ","Z":"ɀ","a":"ꪖ","b":"᥇","c":"ᥴ","d":"ᦔ","e":"ꫀ","f":"ᠻ","g":"ᧁ","h":"ꫝ","i":"ﺃ","j":"꠹","k":"ᛕ","l":"ꪶ","m":"ꪑ","n":"ꪀ","o":"ꪮ","p":"ᜣ","q":"ꪇ","r":"᥅","s":"ᦓ","t":"ꪻ","u":"ꪊ","v":"ꪜ","w":"᭙","x":"᥊","y":"ꪗ","z":"ɀ"},
    33:{"ഒ":"ඉ","എ":"ᬤ","ഉ":"ຂ","ക":"ᤌ‌","ഗ":"ꪭ","ത":"ꫧ","ന":"ღ͢","മ്പ":"൩","വ":"൨","യ":"ᨨ͓","ര":"ᰍ","ി":"᭄","ീ":"ꪻ","ാ":"ꫂ","(":"ꪶ","ു":"⫰","‌്":"᷃","്":"ັ","ർ":"൪","ണ":"𑇥̅","ട":"ຮ","ട്ട":"ჴ","െ":"൭͛","ം":"◕","ഞ":"ൡ̅","േ":"ල","ൽ":"ᰢ","ന്ന":"ꢳ"},
    apply,
    list
}
    return module.exports
})()
const FANCY_STYLES = Object.keys(fancyFonts).filter(k => k.length < 3).length

function quotedText(quoted) {
    if (!quoted || typeof quoted !== 'object') return ''
    for (const node of Object.values(quoted)) {
        if (typeof node === 'string') return node
        if (node && typeof node === 'object') {
            const t = node.text || node.caption || node.conversation
            if (t) return t
        }
    }
    return ''
}

cmd({
    pattern: "fancy",
    alias: ["font", "fonts", "style"],
    desc: "Turn text into fancy fonts. Usage: /fancy hello, /fancy 5 hello, or reply to a text with /fancy",
    category: "tools",
    react: "✨",
    filename: __filename
},
async (conn, mek, m, { args, quoted, prefix, reply }) => {
    try {
        let style = 0
        let words = args.slice()
        if (/^\d{1,2}$/.test(words[0] || '')) {
            const n = parseInt(words[0], 10)
            if (n >= 1 && n <= FANCY_STYLES) { style = n; words.shift() }
        }
        const text = (words.join(' ').trim() || quotedText(quoted).trim())
        if (!text) {
            return reply(`*Fancy text*\n\n` +
                `• ${prefix}fancy hello  → all ${FANCY_STYLES} styles\n` +
                `• ${prefix}fancy 5 hello  → style number 5\n` +
                `• Reply to a text with *${prefix}fancy* or *${prefix}fancy 5*`)
        }
        if (style) return reply(fancyFonts.apply(fancyFonts[style - 1], text))
        reply(`*Fancy text*\n_Use ${prefix}fancy <number> <text> to get a single style._\n` + fancyFonts.list(text, fancyFonts))
    } catch (e) { console.log(e); reply(friendly(e)) }
})

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/3gpp': '3gp',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/ogg; codecs=opus': 'ogg', 'application/pdf': 'pdf' }
const DEFAULT_EXT = { imageMessage: 'jpg', videoMessage: 'mp4', audioMessage: 'ogg', stickerMessage: 'webp', documentMessage: 'bin' }
const firstUrl = (text) => (String(text).replace(/\\\//g, '/').match(/https?:\/\/[^\s"'<>\\]+/) || [])[0] || null

const postForm = async (url, build, headers) => {
    const form = new FormData()
    build(form)
    const r = await fetch(url, { method: 'POST', body: form, headers, signal: AbortSignal.timeout(90000) })
    const text = await r.text()
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return text
}
const blobOf = (buffer, mimetype) => new Blob([buffer], { type: mimetype })
const UPLOAD_HOSTS = [
    { name: 'catbox.moe', keeps: 'permanent',
      send: (b, f, t) => postForm('https://catbox.moe/user/api.php', form => { form.append('reqtype', 'fileupload'); form.append('fileToUpload', blobOf(b, t), f) }) },
    { name: 'uguu.se', keeps: 'about 3 hours',
      send: (b, f, t) => postForm('https://uguu.se/upload', form => form.append('files[]', blobOf(b, t), f)) },
    { name: 'litterbox', keeps: '3 days',
      send: (b, f, t) => postForm('https://litterbox.catbox.moe/resources/internals/api.php', form => { form.append('reqtype', 'fileupload'); form.append('time', '72h'); form.append('fileToUpload', blobOf(b, t), f) }) },
    { name: '0x0.st', keeps: '30 days or more, depends on size',
      send: (b, f, t) => postForm('https://0x0.st', form => form.append('file', blobOf(b, t), f), { 'User-Agent': 'xenoxd-bot/1.0' }) },
    { name: 'tmpfiles.org', keeps: 'about 1 hour',
      send: async (b, f, t) => {
          const text = await postForm('https://tmpfiles.org/api/v1/upload', form => form.append('file', blobOf(b, t), f))
          return String(text).replace(/\\\//g, '/').replace(/(https?:\/\/tmpfiles\.org)\/(?!dl\/)/, '$1/dl/')
      } }
]

async function uploadFile(buffer, filename, mimetype, only) {
    const list = only == null ? UPLOAD_HOSTS : [UPLOAD_HOSTS[only]]
    let last
    for (const h of list) {
        try {
            const link = firstUrl(await h.send(buffer, filename, mimetype))
            if (link) return { link, host: h }
            throw new Error('no link in reply')
        } catch (e) { last = e; console.log(`[URL] ${h.name} failed:`, e?.message || e) }
    }
    throw last || new Error('UPLOAD_FAILED')
}

function urlCommand(pattern, alias, only, desc) {
    cmd({
        pattern, alias, desc, category: "convert", react: "🔗", filename: __filename
    },
    async (conn, mek, m, { from, quoted, prefix, sender, reply }) => {
        try {
            const sel = pickMedia(quoted)
            if (!sel) return reply(needReply(prefix, pattern, 'a photo, video, audio, sticker or file'))
            const wait = cooldown(sender)
            if (wait) return reply(`Please wait ${wait}s before the next upload.`)
            await waitReact(conn, from, mek)

            const buffer = await downloadMedia(sel)
            const mimetype = sel.node.mimetype || 'application/octet-stream'
            const ext = MIME_EXT[mimetype] || MIME_EXT[mimetype.split(';')[0]] || DEFAULT_EXT[sel.type] || 'bin'
            const filename = (sel.type === 'documentMessage' && sel.node.fileName) ? String(sel.node.fileName).replace(/[^\w.\- ]/g, '_') : `xeno-${Date.now()}.${ext}`

            const { link, host } = await uploadFile(buffer, filename, mimetype, only)
            const kb = (buffer.length / 1024).toFixed(buffer.length > 1048576 ? 0 : 1)
            await reply(`*🔗 Link ready*\n\n${link}\n\n_Host: ${host.name} | kept: ${host.keeps} | size: ${kb} KB_`)
            conn.sendMessage(from, { react: { text: '✅', key: mek.key } }).catch(() => {})
        } catch (e) {
            console.log(e)
            conn.sendMessage(from, { react: { text: '❌', key: mek.key } }).catch(() => {})
            const hostName = only == null ? '' : ` on ${UPLOAD_HOSTS[only].name}`
            reply(String(e?.message) === 'FILE_TOO_LARGE' ? 'That file is too large.' : `Upload failed${hostName}. Please try again${only == null ? ' in a moment' : ' or use another one (' + prefix + 'url, ' + prefix + 'url1 ... ' + prefix + 'url5)'}.`)
        }
    })
}

urlCommand('url', ['tourl', 'upload'], null, 'Upload a replied photo, video, audio, sticker or file and get a link (tries every host). Usage: reply with /url')
UPLOAD_HOSTS.forEach((h, i) => urlCommand(`url${i + 1}`, [], i, `Upload a replied file to ${h.name} (kept: ${h.keeps}). Usage: reply with /url${i + 1}`))
