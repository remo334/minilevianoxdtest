//Xeno Exe
const { cmd } = require('../command')


cmd({
    pattern: 'antiedited',
    alias: ['antiedit', 'antiedits'],
    desc: 'Show the original text of edited messages. Usage: antiedited on | off',
    category: 'settings',
    react: '✏️',
    filename: __filename
},
async (conn, mek, m, { q, prefix, isOwner, getSettings, setSetting, reply }) => {
    try {
        if (!isOwner) return reply('Only the bot owner can use this command.')
        const a = (q || '').trim().toLowerCase()
        const cur = (await getSettings()).antiedit || 'off'
        const label = { on: 'ON', off: 'OFF' }

        if (!a || a === 'status') {
            return reply(`*ANTIEDITED*\n│ ✦ STATUS ➱ *${label[cur]}*\n\n➱ ${prefix}antiedited on\n➱ ${prefix}antiedited off`)
        }
        if (!['on', 'off'].includes(a)) return reply(`Unknown option. Use: ${prefix}antiedited on | off`)
        if (a === cur) return reply(`Antiedited is already *${label[a]}*`)

        await setSetting('antiedit', a)
        reply(a === 'on'
            ? 'Antiedited: *ON*\nEdited messages will now show the original text.'
            : 'Antiedited: *OFF*')
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})
