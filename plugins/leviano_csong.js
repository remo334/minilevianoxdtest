//Xeno Exe

const axios = require('axios')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const mongoose = require('mongoose')
const { pipeline } = require('stream/promises')
const { spawn } = require('child_process')
const { downloadContentFromMessage } = require('@whiskeysockets/baileys')
const config = require('../config')
const { cmd } = require('../command')

const SEARCH_API = 'https://xenoytserch.vercel.app/api/ytsearch?q='
const DOWNLOAD_API = 'https://xenoytdl-2.vercel.app/api/youtube?url='
const FFMPEG_TIMEOUT = 120000

const CONTACT_NAME = 'LEVIANO XER'
const CONTACT_NUMBER = '917907997537'
const DEFAULT_POSTER = true
const DEFAULT_CONTACT = false
const MAX_MEDIA_BYTES = 60 * 1024 * 1024

const WATERMARK_PATH = path.join(__dirname, '..', 'assets', 'watermark.png')
const WATERMARK_SIDE = 'bottom-right'
const WATERMARK_WIDTH_PCT = 0.16
const WATERMARK_MARGIN_PCT = 0.04
const WATERMARK_OPACITY = 0.95

let Jimp = null
try { Jimp = require('jimp') } catch { Jimp = null }

async function applyWatermark(thumbBuffer) {
    if (!Jimp || !thumbBuffer) return thumbBuffer
    try {
        if (!fs.existsSync(WATERMARK_PATH)) return thumbBuffer
        const [base, mark] = await Promise.all([
            Jimp.read(thumbBuffer),
            Jimp.read(WATERMARK_PATH)
        ])

        const targetW = Math.round(base.bitmap.width * WATERMARK_WIDTH_PCT)
        mark.resize(targetW, Jimp.AUTO)
        if (WATERMARK_OPACITY < 1) mark.opacity(WATERMARK_OPACITY)

        const margin = Math.round(base.bitmap.width * WATERMARK_MARGIN_PCT)
        let x, y
        switch (WATERMARK_SIDE) {
            case 'bottom-left':  x = margin;                                    y = base.bitmap.height - mark.bitmap.height - margin; break
            case 'top-right':    x = base.bitmap.width - mark.bitmap.width - margin; y = margin; break
            case 'top-left':     x = margin;                                    y = margin; break
            case 'bottom-right':
            default:             x = base.bitmap.width - mark.bitmap.width - margin; y = base.bitmap.height - mark.bitmap.height - margin
        }

        base.composite(mark, x, y)
        return await base.getBufferAsync(Jimp.MIME_PNG)
    } catch (err) {
        console.error('[CSONG] watermark failed:', err.message)
        return thumbBuffer
    }
}

let FFMPEG = 'ffmpeg'
try { FFMPEG = require('ffmpeg-static') || 'ffmpeg' } catch {}
if (process.env.FFMPEG_PATH) FFMPEG = process.env.FFMPEG_PATH

function getYouTubeId(url) {
    const re = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=|shorts\/)([^#\&\?]*).*/
    const match = String(url).match(re)
    return (match && match[2].length === 11) ? match[2] : null
}

const WAVE_STYLES = ['real', 'heartbeat', 'ecg', 'mountain', 'beat', 'pulse', 'equalizer', 'ramp', 'smooth']
const DEFAULT_WAVE = 'real'
const WAVE_BARS = 64

const clampBar = v => Math.max(5, Math.min(100, Math.round(v)))

function smoothBars(arr, passes = 1) {
    let a = arr.slice()
    for (let p = 0; p < passes; p++) {
        a = a.map((v, i) => ((a[i - 1] ?? v) + v * 2 + (a[i + 1] ?? v)) / 4)
    }
    return a
}

const ECG_PATTERN = [0.14, 0.24, 0.30, 0.20, 0.12, 0.06, 0.55, 1.0, 0.30, 0.05, 0.14, 0.22, 0.38, 0.40, 0.26, 0.14]

function styleBars(style) {
    const n = WAVE_BARS
    const out = []
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1)
        let v
        switch (style) {
            case 'mountain': {
                const env = Math.pow(Math.sin(Math.PI * t), 1.1)
                v = 0.14 + 0.86 * env + 0.07 * Math.sin(i * 0.9)
                break
            }
            case 'beat': {
                const base = i % 8 === 0 ? 1 : i % 4 === 0 ? 0.72 : i % 2 === 0 ? 0.46 : 0.24
                v = base * (0.9 + Math.random() * 0.1)
                break
            }
            case 'pulse': {
                const pat = [0.15, 0.2, 0.5, 1, 0.35, 0.7, 0.25, 0.15]
                v = pat[i % 8] * (0.92 + Math.random() * 0.08)
                break
            }
            case 'ecg':
                v = ECG_PATTERN[i % 16] * (0.97 + Math.random() * 0.03)
                break
            case 'ramp':
                v = 0.14 + 0.86 * t + 0.06 * Math.sin(i * 0.8)
                break
            case 'smooth':
                v = 0.5 + 0.34 * Math.sin(i * 0.28) + 0.14 * Math.sin(i * 0.71 + 1)
                break
            case 'equalizer':
            default:
                v = 0.2 + Math.random() * 0.8
        }
        out.push(v * 100)
    }
    return style === 'equalizer' ? smoothBars(out, 2) : out
}

function realBars(file) {
    return new Promise(resolve => {
        let ff
        try {
            ff = spawn(FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'])
        } catch {
            return resolve(null)
        }
        const chunks = []
        let size = 0
        const timer = setTimeout(() => { try { ff.kill('SIGKILL') } catch {} resolve(null) }, 30000)
        ff.stdout.on('data', c => { size += c.length; if (size <= 40 * 1024 * 1024) chunks.push(c) })
        ff.on('error', () => { clearTimeout(timer); resolve(null) })
        ff.on('close', () => {
            clearTimeout(timer)
            try {
                const pcm = Buffer.concat(chunks)
                const samples = Math.floor(pcm.length / 2)
                if (samples < WAVE_BARS) return resolve(null)
                const per = Math.floor(samples / WAVE_BARS)
                const rms = []
                for (let b = 0; b < WAVE_BARS; b++) {
                    let sum = 0
                    for (let i = b * per; i < (b + 1) * per; i++) {
                        const s = pcm.readInt16LE(i * 2)
                        sum += s * s
                    }
                    rms.push(Math.sqrt(sum / per))
                }
                const max = Math.max(...rms)
                if (!max) return resolve(null)
                const norm = rms.map(v => Math.pow(v / max, 0.7) * 100)
                resolve(smoothBars(norm, 1))
            } catch {
                resolve(null)
            }
        })
    })
}

async function buildWaveform(style, audioFile) {
    let bars = null
    if (style === 'real' && audioFile) bars = await realBars(audioFile)
    if (style === 'heartbeat') {
        const loud = audioFile ? await realBars(audioFile) : null
        bars = styleBars('ecg').map((v, i) => loud ? v * (0.35 + 0.65 * (loud[i] / 100)) : v)
    }
    if (!bars) bars = styleBars(style === 'real' ? 'equalizer' : style)
    return new Uint8Array(bars.map(clampBar))
}

const toSeconds = (d) => String(d || '').split(':').reduce((a, b) => a * 60 + (Number(b) || 0), 0)

const YT_RE = /(youtu\.be|youtube\.com)/i

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

async function withTemp(fn) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'csong-' + crypto.randomBytes(3).toString('hex') + '-'))
    try { return await fn(dir) }
    finally { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        let ff
        try { ff = spawn(FFMPEG, ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] }) }
        catch (e) { return reject(e) }
        let err = ''
        const timer = setTimeout(() => { try { ff.kill('SIGKILL') } catch {} reject(new Error('FFMPEG_TIMEOUT')) }, FFMPEG_TIMEOUT)
        ff.stderr.on('data', c => { err = (err + c).slice(-1500) })
        ff.on('error', e => { clearTimeout(timer); reject(e) })
        ff.on('close', code => {
            clearTimeout(timer)
            code === 0 ? resolve() : reject(new Error('FFMPEG_FAILED: ' + err.trim()))
        })
    })
}

async function searchSong(query) {
    const { data } = await axios.get(SEARCH_API + encodeURIComponent(query), { timeout: 30000 })
    const first = data?.results?.[0]
    if (!first || !first.url) throw new Error('NO_RESULT')
    return first
}

async function fetchBuffer(url, maxBytes = MAX_MEDIA_BYTES) {
    const res = await axios.get(url, {
        responseType: 'stream',
        timeout: 120000,
        maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const type = String(res.headers['content-type'] || '')
    if (/text\/|html|json/i.test(type)) { res.data.destroy(); throw new Error('API_FAIL') }
    if (Number(res.headers['content-length']) > maxBytes) { res.data.destroy(); throw new Error('FILE_TOO_LARGE') }
    const chunks = []
    let size = 0
    for await (const c of res.data) {
        size += c.length
        if (size > maxBytes) { res.data.destroy(); throw new Error('FILE_TOO_LARGE') }
        chunks.push(c)
    }
    return Buffer.concat(chunks)
}

async function downloadViaApi(videoUrl) {
    const { data } = await axios.get(DOWNLOAD_API + encodeURIComponent(videoUrl) + '&format=mp3', { timeout: 90000 })
    if (data?.status === false || data?.success === false) throw new Error('API_FAIL')
    const link = findDownloadUrl(data)
    if (!link) throw new Error('API_FAIL')
    return fetchBuffer(link)
}

async function downloadSong(videoUrl) {
    try {
        return await downloadViaApi(videoUrl)
    } catch (e) {
        if (e?.message === 'FILE_TOO_LARGE') throw e
        console.log('[CSONG] api download failed:', e?.message || e)
    }
    let ytdlpDownload
    try { ({ ytdlpDownload } = require('../lib/ytdlp')) } catch { throw new Error('API_FAIL') }
    return (await ytdlpDownload(videoUrl, { kind: 'audio', maxBytes: MAX_MEDIA_BYTES })).buffer
}

async function downloadQuotedAudio(audioNode) {
    const stream = await downloadContentFromMessage(audioNode, 'audio')
    const chunks = []
    let size = 0
    for await (const c of stream) {
        size += c.length
        if (size > MAX_MEDIA_BYTES) throw new Error('FILE_TOO_LARGE')
        chunks.push(c)
    }
    return Buffer.concat(chunks)
}

async function toVoiceNote(buffer, style) {
    return withTemp(async (dir) => {
        const inFile = path.join(dir, 'in.bin')
        const outFile = path.join(dir, 'out.ogg')
        await fs.promises.writeFile(inFile, buffer)
        await runFfmpeg(['-i', inFile, '-vn', '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-ac', '1', '-f', 'ogg', outFile])
        const ogg = await fs.promises.readFile(outFile)
        const waveform = await buildWaveform(style, outFile)
        return { ogg, waveform }
    })
}

async function getThumb(url) {
    if (!url) return null
    try {
        const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 })
        return await applyWatermark(Buffer.from(data))
    } catch (e) {
        console.log('[CSONG] thumbnail failed:', e.message)
        return null
    }
}

const CHANNEL_LINK_RE = /whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i
const NEWSLETTER_JID_RE = /^\d+@newsletter$/i

async function resolveChannel(conn, target) {
    const t = String(target || '').trim()
    if (NEWSLETTER_JID_RE.test(t)) return { jid: t.toLowerCase(), name: null }
    const m = t.match(CHANNEL_LINK_RE)
    if (m) {
        const meta = await conn.newsletterMetadata('invite', m[1])
        if (!meta?.id) throw new Error('CHANNEL_NOT_FOUND')
        return { jid: meta.id, name: meta.name ?? meta.thread_metadata?.name?.text ?? null }
    }
    throw new Error('BAD_TARGET')
}

function parseInput(q) {
    let text = String(q || '').trim()
    let wave = DEFAULT_WAVE
    const w = text.match(/\s*--(?:wave|w)[=\s]+([a-z]+)\s*/i)
    if (w) {
        if (WAVE_STYLES.includes(w[1].toLowerCase())) wave = w[1].toLowerCase()
        text = (text.slice(0, w.index) + ' ' + text.slice(w.index + w[0].length)).trim()
    }
    const i = text.indexOf(',')
    if (i === -1) return { target: text, song: '', wave }
    return { target: text.slice(0, i).trim(), song: text.slice(i + 1).trim(), wave }
}

function posterCaption(v, botName) {
    return `*${v.title || 'Song'}*\n\n` +
        `࿇ ${v.channel || v.author?.name || 'Unknown'}\n` +
        `࿇ ${v.duration || v.timestamp || '-'}\n` +
        (v.views ? `࿇ ${v.views}\n` : '') +
        `\n_${botName}_`
}

function friendly(e) {
    const msg = String(e?.message || e)
    if (msg === 'NO_RESULT') return 'No song found for that name.'
    if (msg === 'BAD_TARGET') return 'That is not a channel link or channel JID.'
    if (msg === 'CHANNEL_NOT_FOUND') return 'Channel not found. Check the link.'
    if (msg === 'FILE_TOO_LARGE') return 'That file is too large.'
    if (msg === 'TOO_LONG') return 'That song is too long.'
    if (msg === 'NO_AUDIO') return 'The replied message is not an audio.'
    if (msg.startsWith('FFMPEG')) return 'Could not convert the audio. Try another song.'
    return 'Could not send the song. Try again.'
}

const MAX_MINUTES = 15

cmd({
    pattern: 'csong',
    alias: ['csend', 'channelsong'],
    desc: 'Send a song to a WhatsApp channel.',
    category: 'owner',
    react: '🎵',
    filename: __filename
},
async (conn, mek, m, { from, q, quoted, prefix, isOwner, isSudo, getSettings, reply }) => {
    try {
        if (!isOwner && !isSudo) return reply('Only the bot owner can use this command.')

        const { target, song, wave } = parseInput(q)
        const audioNode = quoted && !Array.isArray(quoted) ? (quoted.audioMessage || quoted.message?.audioMessage) : null

        if (!target || (!song && !audioNode)) {
            return reply(
                `Usage:\n` +
                `${prefix}csong <channel link/jid> , <song name>\n` +
                `Reply to an audio: ${prefix}csong <channel link/jid>\n` +
                `Optional: --wave <${WAVE_STYLES.join('|')}>`
            )
        }

        const channel = await resolveChannel(conn, target)
        const botName = (await getSettings()).botName || config.BOT_NAME

        let video = null
        let raw
        if (audioNode) {
            raw = await downloadQuotedAudio(audioNode)
        } else {
            video = await searchSong(song)
            if (toSeconds(video.duration || video.timestamp) > MAX_MINUTES * 60) throw new Error('TOO_LONG')
            await reply(`Sending *${video.title}* to ${channel.name || channel.jid} ...`)
            raw = await downloadSong(video.url)
        }

        const { ogg, waveform } = await toVoiceNote(raw, wave)

        if (video && DEFAULT_POSTER) {
            const thumb = await getThumb(video.thumbnail)
            if (thumb) await conn.sendMessage(channel.jid, { image: thumb, caption: posterCaption(video, botName) })
            else await conn.sendMessage(channel.jid, { text: posterCaption(video, botName) })
        }

        if (DEFAULT_CONTACT) {
            const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${CONTACT_NAME}\nTEL;type=CELL;waid=${CONTACT_NUMBER}:+${CONTACT_NUMBER}\nEND:VCARD`
            await conn.sendMessage(channel.jid, { contacts: { displayName: CONTACT_NAME, contacts: [{ vcard }] } })
        }

        await conn.sendMessage(channel.jid, {
            audio: ogg,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            waveform
        })

        await reply(`Sent to ${channel.name || channel.jid} ✅`)
    } catch (e) {
        console.log('[CSONG]', e)
        reply(friendly(e))
    }
})
