//Xeno Exe
const { downloadContentFromMessage } = require('@whiskeysockets/baileys')
const { cmd } = require('../command')

const load = (file, fallback) => {
    try { return [require(file), true] }
    catch (e) { console.error(`${file} could not be loaded: ${String(e.message).split('\n')[0]}`); return [fallback, false] }
}
const [adel, adelOk] = load('../lib/antidelete', { ignore() {}, recent: () => [] })
const [gdb, gdbOk] = load('../lib/groupdb', new Proxy({}, { get: () => async () => { throw new Error('lib/groupdb.js is missing. Add it to your repo, then redeploy.') } }))
const needAdel = c => (adelOk && typeof adel.recent === 'function') ? false : c.reply('lib/antidelete.js is missing or old. Upload the new file, then redeploy.')

const num = j => String(j || '').split('@')[0].split(':')[0]
const target = m => { const c = m.msg && m.msg.contextInfo; return (c && c.mentionedJid && c.mentionedJid[0]) || (c && c.participant) || null }
const bufOf = async (c, k) => { const b = []; for await (const x of await downloadContentFromMessage(c, k)) b.push(x); return Buffer.concat(b) }
const ids = c => c.participants.map(p => p.id)
const list = a => a.map(j => `➱ @${num(j)}`).join('\n')

const G = (pattern, alias, react, desc, o, fn) => cmd({ pattern, alias, react, desc, category: 'group', filename: __filename }, async (conn, mek, m, c) => {
    try {
        const { admin = true, botAdmin = true } = o
        if (!c.isGroup) return c.reply('This command can only be used in a group.')
        if (admin && !c.isAdmins && !c.isOwner) return c.reply('Only group admins can use this command.')
        if (botAdmin && !c.isBotAdmins) return c.reply('Make the bot a group admin first, then try again.')
        await fn(conn, mek, m, c)
    } catch (e) { console.log(e); c.reply('Failed: ' + (e.message || e)) }
})

for (const [p, al, em, act, past] of [
    ['promote', [], '🔼', 'promote', 'promoted to admin'],
    ['demote', [], '🔽', 'demote', 'demoted to member'],
    ['remove', ['kick'], '🚫', 'remove', 'removed from the group']
]) G(p, al, em, `${p[0].toUpperCase() + p.slice(1)} a member. Reply to or tag the user.`, {}, async (conn, mek, m, c) => {
    const u = target(m)
    if (!u) return c.reply(`Please tag or reply to a user to ${p}.`)
    if (act === 'remove' && num(u) === c.botNumber) return c.reply('I cannot remove myself.')
    await conn.groupParticipantsUpdate(c.from, [u], act)
    c.reply(`@${num(u)} has been ${past}.`, { mentions: [u] })
})

G('add', [], '➕', 'Add a member. Usage: add 919XXXXXXXXX', {}, async (conn, mek, m, c) => {
    const n = (c.q || '').replace(/\D/g, '')
    if (n.length < 8) return c.reply(`Give a phone number with country code.\nExample: ${c.prefix}add 919876543210`)
    const jid = n + '@s.whatsapp.net', ex = await conn.onWhatsApp(jid).catch(() => null)
    if (ex && ex[0] && ex[0].exists === false) return c.reply('That number is not on WhatsApp.')
    const st = String(((await conn.groupParticipantsUpdate(c.from, [jid], 'add'))[0] || {}).status)
    c.reply({
        200: `@${n} has been added to the group.`,
        403: `@${n} only allows contacts to add them. Send them the group link instead (${c.prefix}link).`,
        409: 'That user is already in the group.'
    }[st] || `Could not add the user (status ${st}).`, { mentions: [jid] })
})

const tagCool = new Map(), TAG_COOLDOWN = 30, TAG_BATCH = 50
G('tagall', ['everyone'], '📣', 'Mention every member. Usage: tagall [message]', { admin: false, botAdmin: false }, async (conn, mek, m, c) => {
    const g = await gdb.getGroup(c.sessionId, c.from)
    if (!c.isAdmins && !c.isOwner && (g.anti || {}).tagaccess !== 'all') return c.reply(`Only group admins can use this command.\nAdmins can allow everyone with ${c.prefix}tagaccess all`)
    const key = c.sessionId + '|' + c.from, wait = Math.ceil(((tagCool.get(key) || 0) + TAG_COOLDOWN * 1000 - Date.now()) / 1000)
    if (!c.isOwner && wait > 0) return c.reply(`⏳ Please wait ${wait}s before using ${c.prefix}tagall again.`)
    tagCool.set(key, Date.now())

    const all = ids(c), parts = []
    for (let i = 0; i < all.length; i += TAG_BATCH) parts.push(all.slice(i, i + TAG_BATCH))
    for (let p = 0; p < parts.length; p++) {
        const head = p === 0
            ? `📣 *${c.q || 'Attention everyone!'}*\n👥 ${c.groupName} • ${all.length} members\n🙋 By @${c.senderNumber}\n\n`
            : `📣 *(${p + 1}/${parts.length})*\n\n`
        const body = parts[p].map((j, i) => `${p * TAG_BATCH + i + 1}. @${num(j)}`).join('\n')
        await conn.sendMessage(c.from, { text: head + body, mentions: p === 0 ? [...parts[p], c.sender] : parts[p] }, p === 0 ? { quoted: mek } : {})
        if (p < parts.length - 1) await sleep(700)
    }
})

G('tagaccess', ['tagallaccess'], '🔑', 'Choose who can use tagall. Usage: tagaccess all | admins', { botAdmin: false }, async (conn, mek, m, c) => {
    const a = (c.q || '').trim().toLowerCase(), g = await gdb.getGroup(c.sessionId, c.from), cur = (g.anti || {}).tagaccess === 'all' ? 'all members' : 'admins only'
    if (!['all', 'admins'].includes(a)) return c.reply(`*TAGALL ACCESS:* ${cur}\n➱ ${c.prefix}tagaccess all\n➱ ${c.prefix}tagaccess admins`)
    await gdb.setGroupField(c.sessionId, c.from, 'anti', { ...(g.anti || {}), tagaccess: a })
    c.reply(`Tagall can now be used by *${a === 'all' ? 'all members' : 'admins only'}*.`)
})

G('hidetag', ['tag', 'notify'], '🔔', 'Mention everyone silently. Usage: hidetag <text> (or reply to a message)', { botAdmin: false }, (conn, mek, m, c) => {
    const qm = m.quoted, text = c.q || (qm && (qm.conversation || (qm.extendedTextMessage && qm.extendedTextMessage.text) || (qm.msg && (qm.msg.caption || qm.msg.text))))
    if (!text) return c.reply(`Usage: ${c.prefix}hidetag <text>  (or reply to a text message)`)
    return conn.sendMessage(c.from, { text, mentions: ids(c) })
})

G('tagadmins', ['admins', 'listadmins'], '👮', 'List and mention the group admins.', { admin: false, botAdmin: false }, (conn, mek, m, c) => {
    const a = c.participants.filter(p => p.admin).map(p => p.id)
    if (!a.length) return c.reply('No admins found.')
    return conn.sendMessage(c.from, { text: `👮 *Group admins (${a.length})*\n\n${list(a)}${c.q ? '\n\n' + c.q : ''}`, mentions: a }, { quoted: mek })
})

for (const [p, al, em, setting, msg] of [
    ['mute', ['close', 'gclose'], '🔒', 'announcement', 'Group closed. Only admins can send messages now.'],
    ['unmute', ['open', 'gopen'], '🔓', 'not_announcement', 'Group opened. Everyone can send messages now.'],
    ['lock', [], '🔐', 'locked', 'Only admins can edit the group info now.'],
    ['unlock', [], '🔓', 'unlocked', 'All members can edit the group info now.']
]) G(p, al, em, msg.slice(3), {}, async (conn, mek, m, c) => { await conn.groupSettingUpdate(c.from, setting); c.reply(msg) })

G('setname', ['setsubject', 'gname'], '✏️', 'Change the group name. Usage: setname <name>', {}, async (conn, mek, m, c) => {
    const n = (c.q || '').trim()
    if (!n) return c.reply(`Usage: ${c.prefix}setname <new group name>`)
    if (n.length > 100) return c.reply('Name is too long (max 100 characters).')
    await conn.groupUpdateSubject(c.from, n); c.reply(`Group name changed to *${n}*`)
})

G('setdesc', ['setdescription', 'gdesc'], '📝', 'Change the group description. Usage: setdesc <text>', {}, async (conn, mek, m, c) => {
    const t = (c.q || '').trim()
    if (!t) return c.reply(`Usage: ${c.prefix}setdesc <new description>`)
    if (t.length > 2048) return c.reply('Description is too long (max 2048 characters).')
    await conn.groupUpdateDescription(c.from, t); c.reply('Group description updated.')
})

G('gsetpp', ['setgrouppp', 'setgpp'], '🖼️', 'Set the group picture. Reply to an image with this command.', {}, async (conn, mek, m, c) => {
    const q = m.quoted, img = (q && q.type === 'imageMessage' && q.msg) || (m.type === 'imageMessage' && m.msg)
    if (!img) return c.reply(`Reply to an image with ${c.prefix}gsetpp`)
    await conn.updateProfilePicture(c.from, await bufOf(img, 'image')); c.reply('Group picture updated.')
})

G('getpic', ['gpic', 'grouppic'], '🖼️', 'Get the group profile picture.', { admin: false, botAdmin: false }, async (conn, mek, m, c) => {
    const url = await conn.profilePictureUrl(c.from, 'image').catch(() => null)
    if (!url) return c.reply('This group has no profile picture.')
    await conn.sendMessage(c.from, { image: { url }, caption: `*${c.groupName}*` }, { quoted: mek })
})

G('link', ['gclink', 'invite', 'grouplink'], '🔗', 'Get the group invite link.', {}, async (conn, mek, m, c) =>
    c.reply(`🔗 *${c.groupName}*\nhttps://chat.whatsapp.com/${await conn.groupInviteCode(c.from)}`))

G('revoke', ['resetlink', 'revokelink'], '♻️', 'Reset the group invite link.', {}, async (conn, mek, m, c) => {
    await conn.groupRevokeInvite(c.from)
    c.reply(`Link reset. New link:\nhttps://chat.whatsapp.com/${await conn.groupInviteCode(c.from)}`)
})

G('del', ['delete'], '🗑️', 'Delete a message for everyone. Reply to the message.', {}, async (conn, mek, m, c) => {
    const q = m.quoted
    if (!q) return c.reply('Reply to the message you want to delete.')
    adel.ignore(c.sessionId, q.id)
    await conn.sendMessage(c.from, { delete: { remoteJid: c.from, fromMe: q.fromMe, id: q.id, participant: q.sender } })
})

G('leave', ['leavegc', 'leavegroup'], '👋', 'Make the bot leave this group (owner only).', { admin: false, botAdmin: false }, async (conn, mek, m, c) => {
    if (!c.isOwner) return c.reply('Only the bot owner can use this command.')
    await c.reply('Goodbye everyone 👋'); await conn.groupLeave(c.from)
})

const HELP = '\nPlaceholders: @user  @group  @count'
for (const k of ['welcome', 'goodbye']) {
    const L = k[0].toUpperCase() + k.slice(1)
    G(k, [], '👋', `Turn the ${k} message on or off. Usage: ${k} on | off`, { botAdmin: false }, async (conn, mek, m, c) => {
        const a = (c.q || '').trim().toLowerCase()
        if (!['on', 'off'].includes(a)) {
            const cur = (await gdb.getGroup(c.sessionId, c.from))[k] || {}
            return c.reply(`*${L} message:* ${cur.enabled ? 'ON' : 'OFF'}\nUse ${c.prefix}${k} on | off\nCustom text: ${c.prefix}set${k} <text>${HELP}`)
        }
        await gdb.updateGroupObject(c.sessionId, c.from, k, { enabled: a === 'on' })
        c.reply(`${L} message turned *${a.toUpperCase()}*.`)
    })
    G('set' + k, [], '📝', `Set the ${k} text. Usage: set${k} <text>`, { botAdmin: false }, async (conn, mek, m, c) => {
        const t = (c.q || '').trim()
        if (!t) return c.reply(`Usage: ${c.prefix}set${k} <text>${HELP}\nExample: ${c.prefix}set${k} ${k === 'welcome' ? 'Welcome @user to @group!' : 'Bye @user'}`)
        if (t.length > 1000) return c.reply('Text is too long (max 1000 characters).')
        await gdb.updateGroupObject(c.sessionId, c.from, k, { text: t, enabled: true })
        c.reply(`${L} message saved and turned *ON*.`)
    })
}

const KEY = n => (n === 'link' ? 'antilink' : 'anti')
const getCfg = (g, n, def) => ({ enabled: false, action: def, ...(n === 'link' ? g.antilink : (g.anti || {})[n]) })
const saveCfg = async (c, g, n, patch, def) => {
    const cur = getCfg(g, n, def), next = { ...cur, ...patch }
    await gdb.setGroupField(c.sessionId, c.from, KEY(n), n === 'link' ? next : { ...(g.anti || {}), [n]: next })
}

async function punish(conn, c, mek, action, reason) {
    const { from, sessionId, sender, senderNumber } = c, tag = '@' + senderNumber, mentions = [sender]
    adel.ignore(sessionId, mek.key.id)
    await conn.sendMessage(from, { delete: mek.key }).catch(() => {})
    const kick = () => conn.groupParticipantsUpdate(from, [sender], 'remove')
    if (action === 'kick') { await conn.sendMessage(from, { text: `${tag} ${reason} and has been removed.`, mentions }); return kick() }
    if (action === 'warn') {
        const w = await gdb.addWarn(sessionId, from, senderNumber)
        if (w.count >= w.limit) {
            await conn.sendMessage(from, { text: `${tag} reached ${w.limit}/${w.limit} warnings (${reason}) and has been removed.`, mentions })
            await gdb.resetWarn(sessionId, from, senderNumber); return kick()
        }
        return conn.sendMessage(from, { text: `${tag}, ${reason}.\nWarning *${w.count}/${w.limit}*`, mentions })
    }
    return conn.sendMessage(from, { text: `${tag}, ${reason}.`, mentions })
}

const WA_INVITE = /(?:https?:\/\/)?chat\.whatsapp\.com\/[A-Za-z0-9]{10,}/i
const ANY_LINK = /(?:https?:\/\/|www\.)[^\s]+|chat\.whatsapp\.com\/[A-Za-z0-9]+|wa\.me\/[^\s]+/i
const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const normLink = l => String(l).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[?#]/)[0].replace(/\/+$/, '')
const linkReCache = new Map()
const linkRe = l => { if (!linkReCache.has(l)) linkReCache.set(l, new RegExp('(?<![a-z0-9-])(?:[a-z0-9-]+\\.)*' + esc(l) + '(?![a-z0-9_-]|\\.[a-z0-9])', 'i')); return linkReCache.get(l) }
const spam = new Map()
const SPAM_MAX = 5, SPAM_SECS = 6, TAG_MAX = 10

const FEATURES = [
    { n: 'link', def: 'delete', extra: ['wa', 'all'], hint: 'wa = only WhatsApp group links, all = every link',
      test: (c, cfg, m) => (cfg.links && cfg.links.length)
          ? cfg.links.some(l => linkRe(l).test(c.body)) && 'this link is not allowed in this group'
          : (cfg.scope === 'wa' ? WA_INVITE : ANY_LINK).test(c.body) && 'links are not allowed in this group' },
    { n: 'bot', def: 'kick', extra: [], hint: 'removes accounts that look like Baileys bots',
      test: (c, cfg, m, mek) => /^BAE5[0-9A-F]{12}$/.test(mek.key.id || '') && 'bots are not allowed in this group' },
    { n: 'tag', def: 'delete', extra: [], hint: `blocks messages that mention ${TAG_MAX}+ people`,
      test: (c, cfg, m) => ((m.msg && m.msg.contextInfo && m.msg.contextInfo.mentionedJid) || []).length >= TAG_MAX && 'mass tagging is not allowed' },
    { n: 'badword', def: 'delete', extra: [], hint: 'manage words with .badwords add / del / clear / list',
      test: (c, cfg) => { const w = (cfg.words || []).filter(Boolean); return w.length && new RegExp('(?<![\\p{L}\\p{N}])(?:' + w.map(esc).join('|') + ')(?![\\p{L}\\p{N}])', 'iu').test(c.body) && 'watch your language' } },
    { n: 'spam', def: 'warn', extra: [], hint: `blocks ${SPAM_MAX}+ messages within ${SPAM_SECS} seconds`,
      test: (c, cfg) => {
          const k = `${c.sessionId}|${c.from}|${c.sender}`, now = Date.now(), a = (spam.get(k) || []).filter(t => now - t < SPAM_SECS * 1000)
          a.push(now); spam.set(k, a)
          if (a.length < SPAM_MAX) return false
          spam.delete(k); return 'please do not spam'
      } }
]

for (const f of FEATURES) {
    if (f.n === 'link') continue
    const name = 'anti' + f.n
    G(name, f.n === 'link' ? ['al'] : [], '🛡️', `${name} on | off | delete | warn | kick${f.extra.length ? ' | ' + f.extra.join(' | ') : ''}`, { botAdmin: false }, async (conn, mek, m, c) => {
        const g = await gdb.getGroup(c.sessionId, c.from), cfg = getCfg(g, f.n, f.def)
        const a = (c.q || '').trim().toLowerCase(), opts = ['on', 'off', 'delete', 'warn', 'kick', ...f.extra]
        if (!a || a === 'status') {
            return c.reply(`*${name.toUpperCase()}*\n│ ✦ STATUS ➱ *${cfg.enabled ? 'ON' : 'OFF'}*\n│ ✦ ACTION ➱ *${cfg.action}*` +
                (f.n === 'link' ? `\n│ ✦ SCOPE ➱ *${cfg.scope === 'wa' ? 'WhatsApp group links only' : 'all links'}*` : '') +
                (f.n === 'badword' ? `\n│ ✦ WORDS ➱ *${(cfg.words || []).length}*` : '') +
                `\n\n➱ ${c.prefix}${name} ${opts.join(' | ')}\n${f.hint}`)
        }
        if (!opts.includes(a)) return c.reply(`Unknown option. Use: ${c.prefix}${name} ${opts.join(' | ')}`)
        const patch = a === 'on' ? { enabled: true } : a === 'off' ? { enabled: false }
            : f.extra.includes(a) ? { scope: a, enabled: true } : { action: a, enabled: true }
        await saveCfg(c, g, f.n, patch, f.def)
        c.reply(`${name}: ${a === 'off' ? '*OFF*' : '*ON*'}` + (patch.action ? ` (action: *${patch.action}*)` : '') + (patch.scope ? ` (scope: *${patch.scope}*)` : '') +
            (a !== 'off' && !c.isBotAdmins ? '\n\nI am not an admin here, so I cannot delete or kick yet. Make me admin.' : '\nAdmins are never affected.'))
    })
}

const LINK_WORDS = ['on', 'off', 'delete', 'warn', 'kick', 'wa', 'all', 'clear', 'add', 'del', 'status']
G('antilink', ['al'], '🛡️', 'antilink on | off | on,<link>,<link> | add | del | clear | delete | warn | kick | wa | all', { botAdmin: false }, async (conn, mek, m, c) => {
    const g = await gdb.getGroup(c.sessionId, c.from), cfg = getCfg(g, 'link', 'delete'), links = cfg.links || []
    const tokens = (c.q || '').split(/[\s,]+/).filter(Boolean)
    let a = (tokens[0] || '').toLowerCase(), rest = tokens.slice(1)
    if (a && !LINK_WORDS.includes(a) && a.includes('.')) { rest = tokens; a = 'on' }
    const blocking = x => (x.links && x.links.length) ? 'only these links:\n' + x.links.map(l => '   ▸ ' + l).join('\n') : (x.scope === 'wa' ? 'WhatsApp group links only' : 'all links')
    const show = x => `*ANTILINK*\n│ ✦ STATUS ➱ *${x.enabled ? 'ON' : 'OFF'}*\n│ ✦ ACTION ➱ *${x.action}*\n│ ✦ BLOCKING ➱ ${blocking(x)}`

    if (!a || a === 'status') {
        return c.reply(show(cfg) + `\n\n➱ ${c.prefix}antilink on | off\n➱ ${c.prefix}antilink on,https://instagram.com,https://whatsapp.com/abc\n➱ ${c.prefix}antilink add,site.com   |   ${c.prefix}antilink del,site.com   |   ${c.prefix}antilink clear\n➱ ${c.prefix}antilink delete | warn | kick\n➱ ${c.prefix}antilink wa | all   (when no custom links are set)`)
    }
    if (!LINK_WORDS.includes(a)) return c.reply(`Unknown option. Send ${c.prefix}antilink to see how to use it.`)

    const fresh = [...new Set(rest.map(normLink))]
    const bad = fresh.filter(l => !/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(l) || l.length > 100)
    if (bad.length) return c.reply(`These do not look like links: ${bad.join(', ')}\nExample: ${c.prefix}antilink on,https://instagram.com/abc,whatsapp.com`)

    let patch
    if (a === 'off') patch = { enabled: false }
    else if (a === 'clear') patch = { links: [] }
    else if (a === 'add') { if (!fresh.length) return c.reply(`Usage: ${c.prefix}antilink add,https://site.com`); patch = { links: [...new Set([...links, ...fresh])].slice(0, 30), enabled: true } }
    else if (a === 'del') { if (!fresh.length) return c.reply(`Usage: ${c.prefix}antilink del,https://site.com`); patch = { links: links.filter(l => !fresh.includes(l)) } }
    else {
        patch = a === 'on' ? { enabled: true } : (a === 'wa' || a === 'all') ? { scope: a, enabled: true } : { action: a, enabled: true }
        if (fresh.length) patch.links = fresh.slice(0, 30)
    }
    await saveCfg(c, g, 'link', patch, 'delete')
    c.reply(show({ ...cfg, ...patch }) + (patch.enabled !== false && !c.isBotAdmins ? '\n\nI am not an admin here, so I cannot delete or kick yet. Make me admin.' : '\n\nAdmins are never affected.'))
})

G('addbadword', ['addbw'], '➕', 'Add words to the bad word list. Usage: addbadword word1 word2', { botAdmin: false }, async (conn, mek, m, c) => {
    const add = (c.q || '').toLowerCase().split(/[\s,]+/).filter(Boolean)
    if (!add.length) return c.reply(`Usage: ${c.prefix}addbadword word1 word2`)
    const g = await gdb.getGroup(c.sessionId, c.from), words = [...new Set([...(getCfg(g, 'badword', 'delete').words || []), ...add])].slice(0, 100)
    await saveCfg(c, g, 'badword', { words }, 'delete'); c.reply(`Added. Total bad words: *${words.length}*\nTurn it on with ${c.prefix}antibadword on`)
})
G('delbadword', ['delbw'], '➖', 'Remove words from the bad word list. Usage: delbadword word', { botAdmin: false }, async (conn, mek, m, c) => {
    const del = (c.q || '').toLowerCase().split(/[\s,]+/).filter(Boolean)
    if (!del.length) return c.reply(`Usage: ${c.prefix}delbadword word`)
    const g = await gdb.getGroup(c.sessionId, c.from), words = (getCfg(g, 'badword', 'delete').words || []).filter(w => !del.includes(w))
    await saveCfg(c, g, 'badword', { words }, 'delete'); c.reply(`Removed. Total bad words: *${words.length}*`)
})

G('badwords', ['listbadwords', 'bw'], '📋', 'Manage the bad word list. Usage: badwords add w1,w2 | del w1,w2 | clear | list', { botAdmin: false }, async (conn, mek, m, c) => {
    const g = await gdb.getGroup(c.sessionId, c.from)
    const words = getCfg(g, 'badword', 'delete').words || []
    const tokens = (c.q || '').toLowerCase().split(/[\s,]+/).filter(Boolean)
    const a = tokens[0] || 'list'
    const given = [...new Set(tokens.slice(1))]
    const usage = `*BADWORDS*\n➱ ${c.prefix}badwords add xxx,sex,anal,butt\n➱ ${c.prefix}badwords del sex,butt\n➱ ${c.prefix}badwords clear\n➱ ${c.prefix}badwords list\n\nTurn the filter on with ${c.prefix}antibadword on`

    if (a === 'list' || a === 'status') {
        return c.reply(words.length ? `*Bad words (${words.length})*\n${words.join(', ')}\n\n${usage}` : `The bad word list is empty.\n\n${usage}`)
    }

    if (a === 'add') {
        if (!given.length) return c.reply(`Usage: ${c.prefix}badwords add word1,word2,word3`)
        const tooLong = given.filter(w => w.length > 40)
        if (tooLong.length) return c.reply(`These words are too long (max 40 characters): ${tooLong.join(', ')}`)
        const added = given.filter(w => !words.includes(w))
        const next = [...words, ...added].slice(0, 100)
        await saveCfg(c, g, 'badword', { words: next }, 'delete')
        return c.reply(
            `Added *${added.length}* word${added.length === 1 ? '' : 's'}${added.length ? ': ' + added.join(', ') : ' (already in the list)'}\n` +
            `Total bad words: *${next.length}*` +
            (next.length >= 100 ? '\nList is full (max 100).' : '') +
            (getCfg(g, 'badword', 'delete').enabled ? '' : `\n\nThe filter is OFF. Turn it on with ${c.prefix}antibadword on`)
        )
    }

    if (a === 'del' || a === 'remove') {
        if (!given.length) return c.reply(`Usage: ${c.prefix}badwords del word1,word2`)
        const removed = given.filter(w => words.includes(w))
        const next = words.filter(w => !given.includes(w))
        await saveCfg(c, g, 'badword', { words: next }, 'delete')
        return c.reply(`Removed *${removed.length}* word${removed.length === 1 ? '' : 's'}${removed.length ? ': ' + removed.join(', ') : ' (none were in the list)'}\nTotal bad words: *${next.length}*`)
    }

    if (a === 'clear') {
        await saveCfg(c, g, 'badword', { words: [] }, 'delete')
        return c.reply('Bad word list cleared.')
    }

    return c.reply(`Unknown option.\n\n${usage}`)
})

cmd({ on: 'body', dontAddCommandList: true, filename: __filename }, async (conn, mek, m, c) => {
    try {
        if (!gdbOk || !c.isGroup || !c.body || mek.key.fromMe || c.isMe || c.isOwner || c.isAdmins || !c.isBotAdmins) return
        const g = await gdb.getGroup(c.sessionId, c.from)
        for (const f of FEATURES) {
            const cfg = getCfg(g, f.n, f.def)
            if (!cfg.enabled) continue
            const reason = f.test(c, cfg, m, mek)
            if (reason) return await punish(conn, c, mek, cfg.action || f.def, reason)
        }
    } catch (e) { console.error('[ANTI ERROR]', e.message || e) }
})

for (const [p, al, em, desc, fn] of [
    ['warn', [], '⚠️', 'Warn a member (kicked at the warn limit). Reply to or tag the user.', async (conn, c, u, n) => {
        const w = await gdb.addWarn(c.sessionId, c.from, n)
        if (w.count < w.limit) return c.reply(`@${n} has been warned.\nWarning *${w.count}/${w.limit}*`, { mentions: [u] })
        await gdb.resetWarn(c.sessionId, c.from, n)
        if (!c.isBotAdmins) return c.reply(`🚫 @${n} reached ${w.limit}/${w.limit} warnings. I am not an admin, so I cannot remove them.`, { mentions: [u] })
        await c.reply(`🚫 @${n} reached ${w.limit}/${w.limit} warnings and has been removed.`, { mentions: [u] })
        return conn.groupParticipantsUpdate(c.from, [u], 'remove')
    }],
    ['warnings', ['warns'], '📋', 'Show warnings of a member. Reply to or tag the user.', async (conn, c, u, n) => {
        const g = await gdb.getGroup(c.sessionId, c.from)
        return c.reply(`📋 @${n} has *${(g.warns || {})[n] || 0}/${g.warnLimit || 3}* warnings.`, { mentions: [u] })
    }],
    ['resetwarn', ['clearwarn', 'unwarn'], '♻️', 'Clear the warnings of a member. Reply to or tag the user.', async (conn, c, u, n) => {
        await gdb.resetWarn(c.sessionId, c.from, n)
        return c.reply(`Warnings cleared for @${n}.`, { mentions: [u] })
    }]
]) G(p, al, em, desc, { botAdmin: false, admin: p !== 'warnings' }, async (conn, mek, m, c) => {
    const u = target(m)
    if (!u) return c.reply('Please tag or reply to a user.')
    await fn(conn, c, u, num(u))
})

cmd({ pattern: 'antidelete', alias: ['antidel', 'ad'], desc: 'Show messages people delete. Usage: antidelete on | inbox | off', category: 'settings', react: '🗑️', filename: __filename },
async (conn, mek, m, c) => {
    try {
        if (!c.isOwner) return c.reply('Only the bot owner can use this command.')
        const a = (c.q || '').trim().toLowerCase(), cur = (await c.getSettings()).antidelete || 'off'
        const label = { off: 'OFF', chat: 'ON (re-sent in the same chat)', inbox: 'ON (sent to your inbox)' }
        if (!a || a === 'status') return c.reply(`*ANTIDELETE*\n│ ✦ STATUS ➱ *${label[cur]}*\n\n➱ ${c.prefix}antidelete on     (re-send in the same chat)\n➱ ${c.prefix}antidelete inbox  (send to your own chat)\n➱ ${c.prefix}antidelete off`)
        const mode = { on: 'chat', chat: 'chat', inbox: 'inbox', pm: 'inbox', off: 'off' }[a]
        if (!mode) return c.reply(`Unknown option. Use: ${c.prefix}antidelete on | inbox | off`)
        await c.setSetting('antidelete', mode); c.reply(`Antidelete: *${label[mode]}*`)
    } catch (e) { console.log(e); c.reply(`${e}`) }
})

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function wipe(conn, c, keys) {
    let done = 0
    for (const k of keys) {
        adel.ignore(c.sessionId, k.id)
        try { await conn.sendMessage(c.from, { delete: k }); done++ } catch {}
        await sleep(400)
    }
    return done
}

G('purge', ['clear', 'cleanchat'], '🧹', 'Delete the last N messages in the group (default 10, max 50). Usage: purge 20', {}, async (conn, mek, m, c) => {
    if (needAdel(c)) return
    const n = Math.min(Math.max(parseInt(c.q, 10) || 10, 1), 50)
    const keys = adel.recent(c.sessionId, c.from, { limit: n, skipId: mek.key.id })
    if (!keys.length) return c.reply('I have no recent messages to delete. I only know messages sent while I was online.')
    const done = await wipe(conn, c, keys)
    c.reply(`🧹 Deleted *${done}* message${done === 1 ? '' : 's'}.`)
})

G('delall', ['deluser', 'purgeuser'], '🧹', 'Delete the recent messages of a member (max 50). Reply to or tag the user.', {}, async (conn, mek, m, c) => {
    if (needAdel(c)) return
    const u = target(m)
    if (!u) return c.reply('Please tag or reply to the user whose messages you want deleted.')
    const keys = adel.recent(c.sessionId, c.from, { sender: num(u), limit: 50, skipId: mek.key.id })
    if (!keys.length) return c.reply('I have no recent messages from that user.')
    const done = await wipe(conn, c, keys)
    c.reply(`🧹 Deleted *${done}* message${done === 1 ? '' : 's'} from @${num(u)}.`, { mentions: [u] })
})

const MEDIA = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', stickerMessage: 'sticker', documentMessage: 'document' }

function innerOf(q) {
    let type = q.type, msg = q.msg
    for (let i = 0; i < 3 && /^(viewOnce|ephemeral)/.test(type || ''); i++) {
        const inner = (q[type] || {}).message || (msg && msg.message)
        if (!inner) break
        type = Object.keys(inner)[0]; msg = inner[type]; q = inner
    }
    return { type, msg }
}

cmd({ pattern: 'save', alias: ['sv', 'keep'], desc: 'Save a replied message / status / media to your inbox (owner only).', category: 'main', react: '💾', filename: __filename },
async (conn, mek, m, c) => {
    try {
        if (!c.isOwner) return c.reply('Only the bot owner can use this command.')
        if (!m.quoted) return c.reply(`Reply to a message, status or media with ${c.prefix}save`)
        const { type, msg } = innerOf(m.quoted), me = c.botNumber2
        const from = (m.quoted.sender || '').split('@')[0]
        const note = `*Saved*${from ? ' from @' + from : ''}`
        const mentions = m.quoted.sender ? [m.quoted.sender] : []
        const kind = MEDIA[type]

        if (!kind) {
            const text = typeof msg === 'string' ? msg : (msg && (msg.text || msg.conversation || msg.caption))
            if (!text) return c.reply('That message type cannot be saved.')
            await conn.sendMessage(me, { text: `${note}\n\n${text}`, mentions })
        } else {
            const buf = await bufOf(msg, kind), cap = (msg.caption ? '\n\n' + msg.caption : '')
            if (kind === 'image') await conn.sendMessage(me, { image: buf, caption: note + cap, mentions })
            else if (kind === 'video') await conn.sendMessage(me, { video: buf, caption: note + cap, mentions, gifPlayback: !!msg.gifPlayback })
            else if (kind === 'document') await conn.sendMessage(me, { document: buf, mimetype: msg.mimetype, fileName: msg.fileName || 'file', caption: note + cap, mentions })
            else {
                await conn.sendMessage(me, { text: note, mentions })
                await conn.sendMessage(me, kind === 'audio' ? { audio: buf, mimetype: msg.mimetype || 'audio/mpeg', ptt: !!msg.ptt } : { sticker: buf })
            }
        }
        c.reply('Saved')
    } catch (e) { console.log(e); c.reply('Failed to save: ' + (e.message || e)) }
})
