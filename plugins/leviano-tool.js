//Leviano Xd
const { cmd } = require('../command')
const COOLDOWN_MS = 3000
const lastUse = new Map()
const cooldown = (id) => {
    const wait = lastUse.get(id) + COOLDOWN_MS - Date.now()
    if (wait > 0) return Math.ceil(wait / 1000)
    lastUse.set(id, Date.now())
    return 0
}

const CHANNEL_RE = /whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i
const GROUP_RE = /chat\.whatsapp\.com\/([A-Za-z0-9]+)/i

const chatType = (jid) =>
    jid.endsWith('@g.us') ? 'Group' :
    jid.endsWith('@newsletter') ? 'Channel' :
    jid === 'status@broadcast' ? 'Status' :
    jid.endsWith('@broadcast') ? 'Broadcast list' : 'Private chat'

const fmtDate = (t) => {
    const n = Number(t)
    if (!n) return null
    return new Date((n > 1e12 ? n : n * 1000)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

const box = (title, rows) =>
    `╭─❖ 『 ${title} 』 ❖\n` +
    rows.filter(r => r && r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v]) => `│ ✦ ${k} ➱ ${v}`).join('\n') +
    `\n╰──────────────⍟`

function targetJid(mek, q, sender) {
    const ci = mek.message?.extendedTextMessage?.contextInfo
    const mentioned = ci?.mentionedJid?.[0]
    if (mentioned) return mentioned
    if (ci?.participant) return ci.participant
    const digits = String(q || '').replace(/[^0-9]/g, '')
    if (digits.length >= 7 && digits.length <= 15) return digits + '@s.whatsapp.net'
    return sender
}

cmd({
    pattern: "chatjid",
    alias: ["chatid", "cid"],
    desc: "Show the JID of the current chat. Usage: /chatjid",
    category: "tools",
    react: "🆔",
    filename: __filename
},
async (conn, mek, m, { from, reply }) => {
    try {
        reply(box('ᴄʜᴀᴛ ᴊɪᴅ', [['ᴊɪᴅ', from], ['ᴛʏᴘᴇ', chatType(from)]]))
    } catch (e) { console.log(e); reply(`${e}`) }
})

cmd({
    pattern: "myjid",
    alias: ["mejid", "userjid"],
    desc: "Show your JID and the bot's JID. Usage: /myjid",
    category: "tools",
    react: "🆔",
    filename: __filename
},
async (conn, mek, m, { sender, senderNumber, botNumber2, pushname, reply }) => {
    try {
        reply(box('ʏᴏᴜʀ ᴊɪᴅ', [['ɴᴀᴍᴇ', pushname], ['ɴᴜᴍʙᴇʀ', senderNumber], ['ᴊɪᴅ', sender], ['ʙᴏᴛ ᴊɪᴅ', botNumber2]]))
    } catch (e) { console.log(e); reply(`${e}`) }
})

cmd({
    pattern: "channeljid",
    alias: ["cjid", "newsletterjid", "chjid"],
    desc: "Get the JID of a WhatsApp channel. Usage: /channeljid <channel link>",
    category: "tools",
    react: "📢",
    filename: __filename
},
async (conn, mek, m, { q, quoted, prefix, sender, reply }) => {
    try {
        const wait = cooldown(sender)
        if (wait) return

        const link = (q || '').match(CHANNEL_RE)
        if (link) {
            const meta = await conn.newsletterMetadata('invite', link[1])
            if (!meta?.id) return reply('Channel not found. Check the link.')
            const name = meta.name ?? meta.thread_metadata?.name?.text
            const desc = meta.description ?? meta.thread_metadata?.description?.text
            const subs = meta.subscribers ?? meta.subscribers_count ?? meta.thread_metadata?.subscribers_count
            const verified = meta.verification ?? meta.thread_metadata?.verification
            return reply(box('ᴄʜᴀɴɴᴇʟ ɪɴꜰᴏ', [
                ['ɴᴀᴍᴇ', name],
                ['ᴊɪᴅ', meta.id],
                ['ꜰᴏʟʟᴏᴡᴇʀꜱ', subs ? Number(subs).toLocaleString() : null],
                ['ᴠᴇʀɪꜰɪᴇᴅ', verified === 'VERIFIED' ? 'Yes' : null],
                ['ᴄʀᴇᴀᴛᴇᴅ', fmtDate(meta.creation_time ?? meta.thread_metadata?.creation_time)],
                ['ᴅᴇꜱᴄ', desc ? String(desc).slice(0, 200) : null]
            ]))
        }

        if (quoted && typeof quoted === 'object') {
            for (const node of Object.values(quoted)) {
                const info = node?.contextInfo?.forwardedNewsletterMessageInfo
                if (info?.newsletterJid) {
                    return reply(box('ᴄʜᴀɴɴᴇʟ ɪɴꜰᴏ', [['ɴᴀᴍᴇ', info.newsletterName], ['ᴊɪᴅ', info.newsletterJid]]))
                }
            }
        }
        reply(`Usage: ${prefix}channeljid <channel link>\nOr reply to a message forwarded from a channel.`)
    } catch (e) {
        console.log(e)
        reply('Could not read that channel. Check the link.')
    }
})

cmd({
    pattern: "groupjid",
    alias: ["gjid", "groupinfo", "ginfo"],
    desc: "Get a group's JID and info. Usage: /groupjid  (in a group) or /groupjid <invite link>",
    category: "tools",
    react: "👥",
    filename: __filename
},
async (conn, mek, m, { from, q, isGroup, groupMetadata, groupAdmins, prefix, sender, reply }) => {
    try {
        const wait = cooldown(sender)
        if (wait) return

        const link = (q || '').match(GROUP_RE)
        if (link) {
            const info = await conn.groupGetInviteInfo(link[1])
            return reply(box('ɢʀᴏᴜᴘ ɪɴꜰᴏ', [
                ['ɴᴀᴍᴇ', info.subject],
                ['ᴊɪᴅ', info.id],
                ['ᴍᴇᴍʙᴇʀꜱ', info.size],
                ['ᴏᴡɴᴇʀ', info.owner ? info.owner.split('@')[0] : null],
                ['ᴄʀᴇᴀᴛᴇᴅ', fmtDate(info.creation)],
                ['ᴅᴇꜱᴄ', info.desc ? String(info.desc).slice(0, 200) : null]
            ]))
        }

        if (!isGroup || !groupMetadata) return reply(`Use this inside a group, or give an invite link:\n${prefix}groupjid https://chat.whatsapp.com/CODE`)
        const g = groupMetadata
        reply(box('ɢʀᴏᴜᴘ ɪɴꜰᴏ', [
            ['ɴᴀᴍᴇ', g.subject],
            ['ᴊɪᴅ', g.id || from],
            ['ᴍᴇᴍʙᴇʀꜱ', g.participants?.length],
            ['ᴀᴅᴍɪɴꜱ', new Set((groupAdmins || []).map(a => String(a).split('@')[0])).size || null],
            ['ᴏᴡɴᴇʀ', g.owner ? g.owner.split('@')[0] : null],
            ['ᴄʀᴇᴀᴛᴇᴅ', fmtDate(g.creation)],
            ['ᴅᴇꜱᴄ', g.desc ? String(g.desc).slice(0, 200) : null]
        ]))
    } catch (e) {
        console.log(e)
        reply('Could not read that group. Check the link.')
    }
})

cmd({
    pattern: "whois",
    alias: ["userinfo", "who", "info"],
    desc: "Info about a user. Usage: /whois  (reply to someone, mention them, or give a number)",
    category: "tools",
    react: "🔍",
    filename: __filename
},
async (conn, mek, m, { from, q, sender, isGroup, participants, groupAdmins, pushname, botNumber2, reply }) => {
    try {
        const wait = cooldown(sender)
        if (wait) return

        const jid = targetJid(mek, q, sender)
        const number = jid.split('@')[0].split(':')[0]
        const isSelf = jid === sender

        let exists = null, resolvedJid = jid
        try {
            const r = await conn.onWhatsApp(jid)
            if (r && r[0]) { exists = !!r[0].exists; if (r[0].jid) resolvedJid = r[0].jid }
        } catch (e) {}

        let about = null, aboutSet = null
        try {
            const r = await conn.fetchStatus(jid)
            const st = Array.isArray(r) ? r[0]?.status : r?.status
            about = typeof st === 'string' ? st : st?.status
            aboutSet = typeof st === 'object' ? (st?.setAt ? fmtDate(new Date(st.setAt).getTime()) : null) : null
        } catch (e) {}

        let business = null
        try {
            const b = await conn.getBusinessProfile(jid)
            if (b) business = b.description || b.category || 'Yes'
        } catch (e) {}

        let role = null
        if (isGroup) {
            const inGroup = (participants || []).some(p => p.id === jid || p.jid === jid)
            if (inGroup) role = (groupAdmins || []).includes(jid) ? 'Admin' : 'Member'
        }

        let pp = null
        try { pp = await conn.profilePictureUrl(jid, 'image') } catch (e) {}

        const text = box('ᴡʜᴏɪꜱ', [
            ['ɴᴀᴍᴇ', isSelf ? pushname : null],
            ['ɴᴜᴍʙᴇʀ', '+' + number],
            ['ᴊɪᴅ', jid],
            resolvedJid !== jid ? ['ᴡᴀ ᴊɪᴅ', resolvedJid] : null,
            ['ᴏɴ ᴡʜᴀᴛꜱᴀᴘᴘ', exists === null ? null : (exists ? 'Yes' : 'No')],
            ['ᴀʙᴏᴜᴛ', about],
            ['ᴀʙᴏᴜᴛ ꜱᴇᴛ', aboutSet],
            ['ʙᴜꜱɪɴᴇꜱꜱ', business],
            ['ʀᴏʟᴇ', role],
            ['ᴘʀᴏꜰɪʟᴇ ᴘɪᴄ', pp ? 'Shown above' : 'Hidden or none']
        ])

        if (pp) await conn.sendMessage(from, { image: { url: pp }, caption: text, mentions: [jid] }, { quoted: mek })
        else await conn.sendMessage(from, { text, mentions: [jid] }, { quoted: mek })
    } catch (e) { console.log(e); reply('Could not get info for that user.') }
})

cmd({
    pattern: "getpp",
    alias: ["pp", "dp", "profilepic"],
    desc: "Get a user's profile picture. Usage: /getpp  (reply to someone, mention them, or give a number)",
    category: "tools",
    react: "🖼",
    filename: __filename
},
async (conn, mek, m, { from, q, sender, reply }) => {
    try {
        const wait = cooldown(sender)
        if (wait) return
        const jid = targetJid(mek, q, sender)
        let url
        try { url = await conn.profilePictureUrl(jid, 'image') } catch (e) {}
        if (!url) return reply('No profile picture found (it may be hidden).')
        await conn.sendMessage(from, { image: { url }, caption: '+' + jid.split('@')[0].split(':')[0] }, { quoted: mek })
    } catch (e) { console.log(e); reply('Could not get the profile picture.') }
})

const MAX_CAPTION = 500

cmd({
    pattern: "setcaption",
    alias: ["setcap", "dlcaption"],
    desc: "Set the caption used on Instagram, Facebook, TikTok and Twitter downloads. Usage: /setcaption <text>, /setcaption reset",
    category: "tools",
    react: "📝",
    filename: __filename
},
async (conn, mek, m, { q, prefix, isOwner, getSettings, setSetting, reply }) => {
    try {
        if (!isOwner) return reply('Only the bot owner can use this command.')
        const text = (q || '').trim()

        if (!text) {
            const current = ((await getSettings()).caption || '').trim()
            return reply(
                `*Download caption*\n\n` +
                `Current: ${current ? '```' + current + '```' : '_default_'}\n\n` +
                `• ${prefix}setcaption <text>  → set a new caption\n` +
                `• ${prefix}setcaption reset  → back to default\n\n` +
                `_Used on videos from ${prefix}insta, ${prefix}facebook, ${prefix}twitter, ${prefix}tiktok and ${prefix}pin._`
            )
        }

        if (['reset', 'default', 'off', 'remove'].includes(text.toLowerCase())) {
            await setSetting('caption', '')
            return reply('Download caption reset to default.')
        }

        if (text.length > MAX_CAPTION) return reply(`Caption is too long (max ${MAX_CAPTION} characters).`)
        await setSetting('caption', text)
        const saved = ((await getSettings()).caption || '').trim()
        if (saved !== text) return reply('Could not save the caption. Check the database connection and try again.')
        reply(`Download caption set to:\n\n${text}`)
    } catch (e) { console.log(e); reply(`${e.message || e}`) }
})
