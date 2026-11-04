//Xeno Exe
const { cmd } = require('../command')


cmd({
    pattern: "mode",
    alias: ["setmode"],
    desc: "Change bot mode. Usage: /mode private | /mode public",
    category: "settings",
    react: "🔐",
    filename: __filename
},
async (conn, mek, m, { q, prefix, isOwner, getSettings, setSetting, reply }) => {
    try {
        if (!isOwner) return reply('Only the bot owner can use this command.')
        const choice = (q || '').trim().toLowerCase()
        const current = (await getSettings()).mode

        if (!choice) {
            return reply(`*ʙᴏᴛ ᴍᴏᴅᴇ*\n│ ✦ ᴄᴜʀʀᴇɴᴛ ➱ *${current}*\n│ ➱ ${prefix}mode private\n│ ➱ ${prefix}mode public\n`)
        }
        if (!['public', 'private'].includes(choice)) {
            return reply(`Invalid mode. Use: ${prefix}mode private  or  ${prefix}mode public`)
        }
        if (choice === current) return reply(`Bot is already in *${choice}* mode.`)

        await setSetting('mode', choice)
        reply(choice === 'private'
            ? 'Mode changed to *PRIVATE*\nOnly the owner can use commands now.'
            : 'Mode changed to *PUBLIC*\nEveryone can use commands now.')
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})
