//Leviano Xd

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

const CONTACT_NAME = 'LEVIANO SER'
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
            case 'bottom-left':  x = margin;                                     y = base.bitmap.height - mark.bitmap.height - margin; break
            case 'top-right':    x = base.bitmap.width - mark.bitmap.width - margin; y = margin; break
            case 'top-left':     x = margin;                                     y = margin; break
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
        const loud = audioFile ? await realBars
