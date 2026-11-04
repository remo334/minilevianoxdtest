//Xeno Exe
const config = require('../config')
const { cmd } = require('../command')


const OWNER_ONLY = 'Only the bot owner can use this command.'

const validPrefix = (v) => [...v].length >= 1 && [...v].length <= 3 && /^[^\p{L}\p{N}\s]+$/u.test(v)

cmd({
    pattern: "setprefix",
    alias: ["prefix"],
    desc: "Change the command prefix. Usage: /setprefix <symbol>",
    category: "settings",
    react: "🔣",
    filename: __filename
},
async (conn, mek, m, { q, prefix, isOwner, setSetting, reply }) => {
    try {
        if (!isOwner) return reply(OWNER_ONLY)
        const value = (q || '').trim().split(/\s+/)[0]

        if (!value) {
            return reply(`Current prefix: *${prefix}*\n\nUsage: ${prefix}setprefix <symbol>\nExample: ${prefix}setprefix .\nReset: ${prefix}setprefix reset`)
        }

        const next = value.toLowerCase() === 'reset' ? config.PREFIX : value
        if (!validPrefix(next)) {
            return reply('Prefix must be 1 to 3 symbols, with no letters, numbers or spaces.\nExamples: .  !  #  /  $')
        }
        if (next === prefix) return reply(`Prefix is already *${prefix}*`)

        await setSetting('prefix', next)
        reply(`Prefix changed to *${next}*\n\nTry: ${next}ping`)
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})
