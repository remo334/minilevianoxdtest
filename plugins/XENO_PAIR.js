//Xeno Exe
const axios = require('axios')
const { cmd } = require('../command')

const PAIR_URL = 'https://xeno-xd.zone.id/'
const PAIR_API = (process.env.PAIR_URL || PAIR_URL).replace(/\/+$/, '')
const COOLDOWN_MS = 30000
const lastUse = new Map()

cmd({
    pattern: "pair",
    alias: ["getpair", "pairing", "code"],
    desc: "Get a pairing code in chat. Usage: /pair <number with country code>",
    category: "main",
    react: "🔗",
    filename: __filename
},
async (conn, mek, m, { from, q, prefix, sender, reply }) => {
    try {
        const parts = (q || '').trim().split(/\s+/).filter(Boolean)
        const number = (parts[0] || '').replace(/\D/g, '')
        const server = parseInt(parts[1], 10) || null

        if (!number) {
            return reply(
                `*ᴘᴀɪʀ ʏᴏᴜʀ ɴᴜᴍʙᴇʀ*\n\n` +
                `Send your number with the country code:\n` +
                `│ ➱ ${prefix}pair 919876543210\n` +
                `│ ➱ ${prefix}pair 919876543210 2  (pick Server 2)\n\n` +
                `Or use the website:\n│ ✦ ${PAIR_URL}`
            )
        }
        if (number.length < 7 || number.length > 15) {
            return reply(`Invalid number. Use the country code, no + or spaces.\nExample: ${prefix}pair 918136810956`)
        }

        const wait = (lastUse.get(sender) || 0) + COOLDOWN_MS - Date.now()
        if (wait > 0) return reply(`Please wait ${Math.ceil(wait / 1000)}s before requesting another code.`)
        lastUse.set(sender, Date.now())

        await reply(`Requesting*+${number}*…`)

        const { data } = await axios.get(`${PAIR_API}/pair`, {
            params: server ? { number, server } : { number },
            timeout: 40000
        })

        if (!data || !data.code) {
            lastUse.delete(sender)
            return reply('❌' + (data?.error || 'Try again.'))
        }

        const code = String(data.code)
        const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code

        await reply(
            `*ᴘᴀɪʀɪɴɢ ᴄᴏᴅᴇ ꜰᴏʀ +${number}*\n\n` +
            `1. Open WhatsApp → *Settings → Linked devices*\n` +
            `2. Tap *Link a device* → *Link with phone number instead*\n` +
            `3. Enter the code below\n\n` +
            `The code expires in a minute or two.`
        )
        await conn.sendMessage(from, { text: pretty }, { quoted: mek })
    } catch (e) {
        console.log('[PAIR]', e?.message || e)
        lastUse.delete(sender)
        reply('ERROR' + PAIR_URL)
    }
})
