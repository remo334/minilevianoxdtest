//Xeno Exe

const fs = require('fs')
const os = require('os')
const path = require('path')
const axios = require('axios')
const { spawn } = require('child_process')

let FFMPEG = null
try { FFMPEG = require('ffmpeg-static') || null } catch (e) { }

const BIN_DIR = path.join(__dirname, '..', 'bin')

function assetName() {
    if (process.platform === 'win32') return 'yt-dlp.exe'
    if (process.platform === 'darwin') return 'yt-dlp_macos'
    return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

function run(bin, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        let p
        try { p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { return reject(e) }
        let out = '', err = ''
        const timer = setTimeout(() => { p.kill('SIGKILL'); err += '\nTIMEOUT' }, timeoutMs)
        p.stdout.on('data', c => { out = (out + c).slice(-4000) })
        p.stderr.on('data', c => { err = (err + c).slice(-4000) })
        p.on('error', e => { clearTimeout(timer); reject(e) })
        p.on('close', code => { clearTimeout(timer); resolve({ code, out, err }) })
    })
}

let binPromise = null
async function findOrInstall() {
    if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH

    const local = path.join(BIN_DIR, assetName())
    if (fs.existsSync(local)) return local

    try {
        const r = await run('yt-dlp', ['--version'], 10000)
        if (r.code === 0) return 'yt-dlp'
    } catch (e) { }

    console.log('[YTDLP] downloading yt-dlp binary (one time)...')
    await fs.promises.mkdir(BIN_DIR, { recursive: true })
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName()}`
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000, maxRedirects: 5 })
    const tmp = local + '.part'
    await fs.promises.writeFile(tmp, res.data)
    await fs.promises.chmod(tmp, 0o755)
    await fs.promises.rename(tmp, local)
    console.log('[YTDLP] installed:', local)
    return local
}

function getBin() {
    if (!binPromise) binPromise = findOrInstall().catch(e => { binPromise = null; throw e })
    return binPromise
}

const isYouTube = (u) => /(youtu\.be|youtube\.com)/i.test(u)

async function ytdlpDownload(url, { kind = 'video', maxBytes }) {
    const bin = await getBin()
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ytdlp-'))
    try {
        const base = [
            '--no-playlist', '--no-warnings', '--no-progress', '--restrict-filenames',
            '--socket-timeout', '20', '--retries', '2',
            '--max-filesize', String(maxBytes),
            '-o', path.join(dir, 'out.%(ext)s')
        ]
        if (FFMPEG) base.push('--ffmpeg-location', FFMPEG)
        if (process.env.YTDLP_COOKIES) base.push('--cookies', process.env.YTDLP_COOKIES)
        if (process.env.YTDLP_PROXY) base.push('--proxy', process.env.YTDLP_PROXY)

        if (kind === 'audio') {
            base.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '128K')
        } else {
            base.push('-f', 'b[ext=mp4][height<=720]/bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/b',
                '--merge-output-format', 'mp4')
        }

        const extra = isYouTube(url) ? ['--js-runtimes', 'node'] : []

        let r = await run(bin, [...base, ...extra, url], 240000)
        if (r.code !== 0 && extra.length && /no such option|unrecognized arguments/i.test(r.err)) {
            r = await run(bin, [...base, url], 240000)
        }

        const files = (await fs.promises.readdir(dir)).filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl'))
        if (!files.length) {
            console.log('[YTDLP] failed (code ' + r.code + '):\n' + r.err.slice(-1200))
            if (/larger than max-filesize|File is larger/i.test(r.err + r.out)) throw new Error('FILE_TOO_LARGE')
            if (/Sign in to confirm|not a bot/i.test(r.err)) throw new Error('YT_BLOCKED')
            throw new Error('YTDLP_FAILED')
        }

        const file = path.join(dir, files[0])
        const { size } = await fs.promises.stat(file)
        if (size > maxBytes) throw new Error('FILE_TOO_LARGE')
        return { buffer: await fs.promises.readFile(file), ext: path.extname(file).slice(1).toLowerCase() }
    } finally {
        fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
}

module.exports = { ytdlpDownload }
