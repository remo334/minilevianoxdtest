//Xeno Exe
const axios = require('axios')
const { cmd, commands } = require('../command')
const { runtime } = require('../lib/functions')

const SMALL_CAPS = {
    a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ',
    j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ',
    s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ'
}
const fancy = (str) => String(str).toLowerCase().split('').map(ch => SMALL_CAPS[ch] || ch).join('')

const ICONS = {
    main: '',
    group: '',
    settings: '',
    misc: '',
    owner: '',
    download: '',
    fun: '',
    tools: '',
    pinterest: ''
}
const DEFAULT_ICON = '✦'

const ORDER = ['main', 'group', 'settings']

const S = {
    arrow: '➥',
    dot: '✦',
    top: '╭──────────────⍟',
    mid: '│',
    bot: '╰──────────────⍟'
}

cmd({
    pattern: "menu",
    alias: ["help", "list"],
    desc: "Show the bot menu.",
    category: "main",
    react: "📜",
    filename: __filename
},
async (conn, mek, m, { from, prefix, pushname, isOwner, getSettings, reply }) => {
    try {
        const s = await getSettings()

        const groups = {}
        let total = 0
        for (const c of commands) {
            if (!c.pattern || c.dontAddCommandList) continue
            const cat = (c.category || 'misc').toLowerCase()
            if (!groups[cat]) groups[cat] = []
            groups[cat].push(c.pattern)
            total++
        }

        const cats = Object.keys(groups).sort((a, b) => {
            const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b)
            if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
            return a.localeCompare(b)
        })

        let text = `${S.top}\n`
        text += `${S.mid} ${S.dot} ${fancy('bot')} ${S.arrow} *${s.botName}*\n`
        text += `${S.mid} ${S.dot} ${fancy('user')} ${S.arrow} ${pushname || 'User'}\n`
        text += `${S.mid} ${S.dot} ${fancy('role')} ${S.arrow} ${isOwner ? 'Owner' : 'Member'}\n`
        text += `${S.mid} ${S.dot} ${fancy('mode')} ${S.arrow} ${s.mode === 'private' ? 'Private' : 'Public'}\n`
        text += `${S.mid} ${S.dot} ${fancy('prefix')} ${S.arrow} ${prefix}\n`
        text += `${S.mid} ${S.dot} ${fancy('commands')} ${S.arrow} ${total}\n`
        text += `${S.mid} ${S.dot} ${fancy('uptime')} ${S.arrow} ${runtime(process.uptime()) || '0 seconds'}\n`
        text += `${S.bot}\n`

        for (const cat of cats) {
            const icon = ICONS[cat] || DEFAULT_ICON
            text += `\n╭─❖ 『 ${icon} ${fancy(cat)} 』 ❖\n`
            for (const p of groups[cat].sort()) {
                text += `${S.mid} ${S.arrow} ${prefix}${p}\n`
            }
            text += `${S.bot}\n`
        }

        text += `\n> ${s.botInfo}`

        try {
            const r = await axios.head(s.menuUrl, { timeout: 8000, maxRedirects: 5 })
            const type = (r.headers['content-type'] || '').toLowerCase()
            if (type.startsWith('video/')) {
                return await conn.sendMessage(from, { video: { url: s.menuUrl }, caption: text }, { quoted: mek })
            }
            return await conn.sendMessage(from, { image: { url: s.menuUrl }, caption: text }, { quoted: mek })
        } catch (err) {
            return reply(text)
        }
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})
