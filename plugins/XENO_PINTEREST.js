//Xeno Exe
const axios = require('axios')
const { cmd } = require('../command')
const { ytdlpDownload } = require('../lib/ytdlp')
const { fetchSafe, toBuffer, MAX_BYTES } = require('./leviano_download')
const IMG_COUNT = 5
const COOLDOWN_MS = 8000
const lastUse = new Map()
const waitTurn = async (id, conn, from, mek) => {
    const slot = Math.max(Date.now(), (lastUse.get(id) || 0) + COOLDOWN_MS)
    const delay = slot - Date.now()
    if (delay > 300000) return false
    lastUse.set(id, slot)
    if (delay > 0) {
        conn?.sendMessage(from, { react: { text: '⏳', key: mek.key } }).catch(() => {})
        await new Promise(r => setTimeout(r, delay))
    }
    return true
}

const cooldown = (id) => {
    const wait = lastUse.get(id) + COOLDOWN_MS - Date.now()
    if (wait > 0) return Math.ceil(wait / 1000)
    lastUse.set(id, Date.now())
    return 0
}

const UA = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9'
}
const PIN_RE = /https?:\/\/(?:[a-z]{2,3}\.|www\.)?(?:pinterest\.[a-z.]+\/pin\/[A-Za-z0-9_-]+|pin\.it\/[A-Za-z0-9_-]+)[^\s]*/i

const react = (conn, from, mek, text) => conn.sendMessage(from, { react: { text, key: mek.key } }).catch(() => {})
const linkFrom = (q, quoted) => {
    const qm = quoted || {}
    const quotedText = qm.conversation || qm.extendedTextMessage?.text || qm.imageMessage?.caption || qm.videoMessage?.caption || qm.msg?.text || qm.msg?.caption || qm.text || ''
    return ((q || '').match(PIN_RE) || String(quotedText).match(PIN_RE) || [])[0]
}

async function pinPage(url) {
    const { res } = await fetchSafe(url)
    const html = (await toBuffer(res.data, 3 * 1024 * 1024)).toString('utf8')
    return html
}

const unescape = (s) => s.replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&')
const originalSize = (u) => u.replace(/\/(?:\d+x\d*|\d+x)\//, '/originals/')

const PIN_API = process.env.PIN_API || 'https://xeno-pinterest.vercel.app/api/pinterest'
async function searchPins(query) {
    const { data: json } = await axios.get(PIN_API, {
        params: { query },
        headers: { ...UA, Accept: 'application/json' },
        timeout: 25000
    })
    if (!json || json.status === false) throw new Error(json?.message || 'API_ERROR')
    const urls = []
    for (const r of (json.data || [])) {
        const u = r?.image
        if (u && !urls.includes(u)) urls.push(u)
    }
    return urls
}

function pinImageFromHtml(html) {
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)
    return og ? originalSize(unescape(og[1])) : null
}
function pinVideoFromHtml(html) {
    const all = [...html.matchAll(/https?:(?:\\?\/){2}v1?\.pinimg\.com(?:\\?\/)videos[^"'\s\\]*(?:\\?\/)[^"'\s]*?\.mp4/gi)].map(m => unescape(m[0]))
    const uniq = [...new Set(all)]
    const rank = (u) => (u.match(/(\d{3,4})p/) || [])[1] ? Number(u.match(/(\d{3,4})p/)[1]) : 0
    uniq.sort((a, b) => rank(b) - rank(a))
    return uniq[0] || null
}

const sendImage = async (conn, from, mek, url, caption) => {
    const { res } = await fetchSafe(url)
    if (Number(res.headers['content-length'] || 0) > MAX_BYTES) { res.data.destroy(); throw new Error('FILE_TOO_LARGE') }
    const buffer = await toBuffer(res.data)
    await conn.sendMessage(from, { image: buffer, caption }, { quoted: mek })
}

const CAPTION = 'X E N O X D 🤍'
const capFor = async (getSettings) => { try { return String((await getSettings()).caption || '').trim() || CAPTION } catch (e) { return CAPTION } }
const fail = (m) => m === 'FILE_TOO_LARGE' ? 'File is too large.' : m === 'NO_RESULT' ? 'No results found.' : m === 'NO_MEDIA' ? 'Could not find that media in the pin.' : '_SORRY, ERROR. TRY AGAIN_'

cmd({
    pattern: "pin",
    alias: ["pinterest", "pin5", "pinimg"],
    desc: "Get 5 Pinterest images. Usage: /pin <search> or /pin <pin link>",
    category: "pinterest",
    react: "📌",
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, quoted, sender, getSettings, reply }) => {
    try {
        const CAP = await capFor(getSettings)
        const link = linkFrom(q, quoted)
        if (!link && !(q || '').trim()) return reply(`Usage:\n${prefix}pin <search words>  → 5 images\n${prefix}pin <pin link>  → that pin's image`)
        if (!(await waitTurn(sender, conn, from, mek))) return
        await react(conn, from, mek, '⏳')

        if (link) {
            const img = pinImageFromHtml(await pinPage(link))
            if (!img) throw new Error('NO_MEDIA')
            await sendImage(conn, from, mek, img, CAP)
            return react(conn, from, mek, '✅')
        }

        const query = q.trim()
        const urls = (await searchPins(query)).slice(0, IMG_COUNT + 3)
        if (!urls.length) throw new Error('NO_RESULT')

        let sent = 0, lastErr = null
        for (const u of urls) {
            if (sent >= IMG_COUNT) break
            try {
                await sendImage(conn, from, mek, u, sent === 0 ? `📌 *${query}*\n${CAP}` : undefined)
                sent++
            } catch (err) { lastErr = err; console.log('[PIN] image failed:', err.message) }
        }
        if (!sent) throw lastErr || new Error('NO_RESULT')
        react(conn, from, mek, '✅')
    } catch (e) {
        console.log(e)
        react(conn, from, mek, '❌')
        reply(fail(String(e?.message || e)))
    }
})

const MP4_RE = /https?:(?:\\?\/){2}(?:[^"'\s<>\\]|\\\/|\\u002F)+?\.mp4(?:[^"'\s<>\\]|\\\/|\\u002F)*/gi
const mp4sFrom = (text) => [...new Set([...String(text).matchAll(MP4_RE)].map(m => unescape(m[0])))]
const rankUrl = (u) => Number((u.match(/(\d{3,4})p/) || [])[1] || 0)
const bestMp4 = (list) => list.filter(u => /\.mp4/i.test(u)).sort((a, b) => rankUrl(b) - rankUrl(a))[0] || null

async function pinPageFull(link) {
    const r = await axios.get(link, { headers: UA, timeout: 25000, maxRedirects: 5, responseType: 'text', maxContentLength: 5 * 1024 * 1024 })
    return { html: String(r.data), url: r.request?.res?.responseUrl || link }
}
const pinIdFrom = (url) => (String(url).match(/\/pin\/(?:[^/?#]*--)?(\d+)/) || String(url).match(/\/pin\/([A-Za-z0-9_-]+)/) || [])[1]

async function viaPinResource(link) {
    let url = link, id = pinIdFrom(link)
    if (!id || /pin\.it/i.test(link)) { const pg = await pinPageFull(link); url = pg.url; id = pinIdFrom(url) || (pg.html.match(/"pin_id"\s*:\s*"?(\d+)/) || [])[1] }
    if (!id) throw new Error('no pin id')
    const data = { options: { id, field_set_key: 'unauth_react_main_pin', noCache: true, fetch_visual_search_objects: false }, context: {} }
    const { data: json } = await axios.get('https://www.pinterest.com/resource/PinResource/get/', {
        params: { source_url: `/pin/${id}/`, data: JSON.stringify(data) },
        headers: { ...UA, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-Pinterest-AppState': 'active' },
        timeout: 25000
    })
    const d = json?.resource_response?.data || {}
    const found = []
    const vl = d?.videos?.video_list || {}
    for (const k of Object.keys(vl)) if (vl[k]?.url) found.push(vl[k].url)
    for (const pg of (d?.story_pin_data?.pages || [])) for (const b of (pg.blocks || [])) {
        const l = b?.video?.video_list || {}
        for (const k of Object.keys(l)) if (l[k]?.url) found.push(l[k].url)
    }
    found.push(...mp4sFrom(JSON.stringify(d)))
    const v = bestMp4(found)
    if (!v) throw new Error('no video in pin resource')
    return v
}

async function viaPage(link) {
    const { html } = await pinPageFull(link)
    const og = html.match(/<meta[^>]+property=["']og:video(?::url|:secure_url)?["'][^>]+content=["']([^"']+)/i)
    const v = bestMp4([...(og ? [unescape(og[1])] : []), ...mp4sFrom(html)])
    if (!v) throw new Error('no video in page')
    return v
}

const KP_HOME = 'https://klickpin.com/en5'
async function viaKlickpin(link) {
    const base = { ...UA, Referer: KP_HOME, Origin: 'https://klickpin.com' }
    const home = await axios.get(KP_HOME, { headers: base, timeout: 20000, responseType: 'text' })
    const cookie = (home.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ')
    const html = String(home.data)
    let endpoint = process.env.KLICKPIN_ENDPOINT
    let field = process.env.KLICKPIN_FIELD || 'url'
    const body = new URLSearchParams()
    if (!endpoint) {
        const form = (html.match(/<form[\s\S]*?<\/form>/i) || [''])[0]
        const action = (form.match(/action=["']([^"']*)["']/i) || [])[1]
        endpoint = new URL(action || KP_HOME, KP_HOME).href
        const inputs = [...form.matchAll(/<input[^>]*>/gi)].map(m => m[0])
        for (const inp of inputs) {
            const name = (inp.match(/name=["']([^"']+)["']/i) || [])[1]
            if (!name) continue
            const type = (inp.match(/type=["']([^"']+)["']/i) || [])[1] || 'text'
            if (type === 'hidden') body.set(name, (inp.match(/value=["']([^"']*)["']/i) || [])[1] || '')
            else if (/text|url|search/i.test(type)) field = name
        }
    }
    body.set(field, link)
    const r = await axios.post(endpoint, body.toString(), {
        headers: { ...base, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', ...(cookie ? { Cookie: cookie } : {}) },
        timeout: 40000, responseType: 'text', maxRedirects: 5, validateStatus: s => s < 500
    })
    const v = bestMp4(mp4sFrom(typeof r.data === 'string' ? r.data : JSON.stringify(r.data)))
    if (!v) throw new Error('no video from klickpin')
    return v
}

async function downloadVideoBuffer(url) {
    const { res } = await fetchSafe(url)
    if (Number(res.headers['content-length'] || 0) > MAX_BYTES) { res.data.destroy(); throw new Error('FILE_TOO_LARGE') }
    return toBuffer(res.data)
}

async function canonicalPin(link) {
    const direct = pinIdFrom(link)
    if (direct && !/pin\.it/i.test(link)) return `https://www.pinterest.com/pin/${direct}/`
    const pg = await pinPageFull(link)
    const id = pinIdFrom(pg.url) || (pg.html.match(/"pin_id"\s*:\s*"?(\d+)/) || [])[1]
    return id ? `https://www.pinterest.com/pin/${id}/` : link
}

async function getPinVideo(rawLink) {
    let link = rawLink
    try { link = await canonicalPin(rawLink) } catch (err) { console.log('[PINVIDEO] link expand failed:', err.message) }
    const methods = [['pinresource', viaPinResource], ['page', viaPage], ['klickpin', viaKlickpin]]
    for (const [name, fn] of methods) {
        try {
            const url = await fn(link)
            return await downloadVideoBuffer(url)
        } catch (err) {
            if (err.message === 'FILE_TOO_LARGE') throw err
            console.log(`[PINVIDEO] ${name} failed:`, err.message)
        }
    }
    try { return (await ytdlpDownload(link, { kind: 'video', maxBytes: MAX_BYTES })).buffer }
    catch (err) {
        if (err.message === 'FILE_TOO_LARGE') throw err
        console.log('[PINVIDEO] yt-dlp failed:', err.message)
        throw new Error('NO_MEDIA')
    }
}

cmd({
    pattern: "pinvideo",
    alias: ["pinvid", "pinv", "pindl"],
    desc: "Download a Pinterest video. Usage: /pinvideo <pin link>",
    category: "pinterest",
    react: "🎬",
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, quoted, sender, getSettings, reply }) => {
    try {
        const CAP = await capFor(getSettings)
        const link = linkFrom(q, quoted)
        if (!link) return reply(`Usage: ${prefix}pinvideo <Pinterest pin link>`)
        if (!(await waitTurn(sender, conn, from, mek))) return
        await react(conn, from, mek, '⏳')
        const buffer = await getPinVideo(link)
        await conn.sendMessage(from, { video: buffer, mimetype: 'video/mp4', caption: CAP }, { quoted: mek })
        react(conn, from, mek, '✅')
    } catch (e) {
        console.log(e)
        react(conn, from, mek, '❌')
        reply(fail(String(e?.message || e)))
    }
})
