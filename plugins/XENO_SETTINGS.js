//Xeno Exe
const axios = require('axios')
const config = require('../config')
const { cmd, commands } = require('../command')

const MAX_NAME = 40
const MAX_INFO = 500

const OWNER_ONLY = 'Only the bot owner can use this command.'

cmd({
    pattern: "setbotname",
    alias: ["botname"],
    desc: "Change the bot name. Usage: /setbotname <name>",
    category: "settings",
    react: "✏️",
    filename: __filename
},
async (conn, mek, m, { q, prefix, isOwner, setSetting, reply }) => {
    try {
        if (!isOwner) return reply(OWNER_ONLY)
        const name = (q || '').trim()
        if (!name) return reply(`Usage: ${prefix}setbotname <new name>`)
        if (name.length > MAX_NAME) return reply(`Name is too long (max ${MAX_NAME} characters).`)
        await setSetting('botName', name)
        reply(`Bot name changed to: *${name}*`)
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})

cmd({
    pattern: "setmenuurl",
    alias: ["menuurl", "setmenuimg"],
    desc: "Change the menu image/video URL. Usage: /setmenuurl <url>",
    category: "settings",
    react: "🖼️",
    filename: __filename
},
async (conn, mek, m, { q, prefix, isOwner, setSetting, reply }) => {
    try {
        if (!isOwner) return reply(OWNER_ONLY)
        const url = (q || '').trim().split(/\s+/)[0]
        if (!url) return reply(`Usage: ${prefix}setmenuurl <image or video url>`)
        if (!/^https?:\/\/\S+$/i.test(url)) return reply('Please send a valid http(s) link.')

        let type = ''
        try {
            const r = await axios.head(url, { timeout: 10000, maxRedirects: 5 })
            type = (r.headers['content-type'] || '').toLowerCase()
        } catch (err) {
            return reply('Could not reach that link. Make sure it is a direct, public image/video URL.')
        }
        if (!type.startsWith('image/') && !type.startsWith('video/')) {
            return reply(`That link is not an image or video (got: ${type || 'unknown'}). Use a direct file link.`)
        }

        await setSetting('menuUrl', url)
        reply('Menu URL updated. Send the menu command to preview it.')
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})

cmd({
    pattern: "setbotinfo",
    alias: ["botinfoset"],
    desc: "Change the bot info text. Usage: /setbotinfo <text>",
    category: "settings",
    react: "📝",
    filename: __filename
},
async (conn, mek, m, { q, prefix, isOwner, setSetting, reply }) => {
    try {
        if (!isOwner) return reply(OWNER_ONLY)
        const info = (q || '').trim()
        if (!info) return reply(`Usage: ${prefix}setbotinfo <info text>`)
        if (info.length > MAX_INFO) return reply(`Info is too long (max ${MAX_INFO} characters).`)
        await setSetting('botInfo', info)
        reply('Bot info updated.')
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})

cmd({
    pattern: "botinfo",
    alias: ["info"],
    desc: "Show the current bot name, mode, menu URL and info.",
    category: "settings",
    react: "ℹ️",
    filename: __filename
},
async (conn, mek, m, { from, getSettings, reply }) => {
    try {
        const s = await getSettings()
        reply(`*${s.botName}*\n\n${s.botInfo}\n\n*Mode:* ${s.mode}\n*Menu URL:* ${s.menuUrl}`)
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})

cmd({
    pattern: "resetsettings",
    desc: "Reset bot name, menu URL, info and mode to defaults.",
    category: "settings",
    react: "♻️",
    filename: __filename
},
async (conn, mek, m, { isOwner, resetSettings, reply }) => {
    try {
        if (!isOwner) return reply(OWNER_ONLY)
        await resetSettings()
        reply('Settings reset to defaults.')
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})

