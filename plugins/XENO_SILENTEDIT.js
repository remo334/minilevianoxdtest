//Xeno Exe
const { cmd } = require('../command')


const num = j => String(j || '').split('@')[0].split(':')[0]

cmd({
    pattern: 'sedit',
    alias: ['silentedit', 'noedit'],
    desc: 'Edit your own message without the "Edited" label. Reply to your message: sedit <new text>',
    category: 'tools',
    filename: __filename
},
async (conn, mek, m, { from, body, prefix, isGroup, isOwner, botNumber, reply }) => {
    try {
        if (!isOwner) return reply('Only the bot owner can use this command.')

        const ci = m.msg && m.msg.contextInfo
        if (!ci || !ci.stanzaId) return reply(`Reply to YOUR message with *${prefix}sedit <new text>*`)

        const botLid = num(conn.user && conn.user.lid)
        const who = num(ci.participant)
        if (who && who !== num(botNumber) && who !== botLid) return reply('You can only edit your own messages.')

        const text = body.slice(prefix.length).trim().replace(/^\S+\s*/, '')
        if (!text) return reply(`Usage: reply to your message with *${prefix}sedit <new text>*`)

        await conn.sendMessage(from, { text })

        const delKey = id => ({ remoteJid: from, fromMe: true, id, ...(isGroup ? { participant: conn.user.id } : {}) })
        await conn.sendMessage(from, { delete: delKey(ci.stanzaId) })
        await conn.sendMessage(from, { delete: mek.key })
    } catch (e) {
        console.log(e)
        reply(`${e}`)
    }
})
