//Xeno Exe
// Always online / auto typing / auto recording / auto seen  (per bot number, saved in MongoDB)
//
//   !alwaysonline on|off
//   !autotyping on|off
//   !autorecording on|off
//   !autoseen on|off
//   !autoreact on|off
//   !autostatus            -> shows all four
//
// This file also exports the runtime hooks that pair.js calls (load / apply / presenceType / onMessage).

const mongoose = require('mongoose')
const config = require('../config')
const { cmd } = require('../command')
const { isConnected, getModel } = require('../lib/db')
const { serverOf } = require('../lib/servers')

const OWNER_ONLY = 'Only the bot owner can use this command.'
const KEYS = ['alwaysonline', 'autotyping', 'autorecording', 'autoseen', 'autoreact']
const LABEL = {
    alwaysonline: 'Always Online',
    autotyping: 'Auto Typing',
    autorecording: 'Auto Recording',
    autoseen: 'Auto Seen',
    autoreact: 'Auto React'
}
const REACT_CHANCE = 1      // 1 = react to every message, 0.3 = about 1 in 3 (lower is safer for big groups)
const DEFAULT_EMOJIS = ['❤', '😍', '🔥', '👍', '😂', '🎉', '💯', '😎']
const TYPING_MS = 4000   // how long "typing..." / "recording..." stays visible after a message

const schema = new mongoose.Schema({
    sessionId: { type: String, unique: true, index: true },
    alwaysonline: Boolean,
    autotyping: Boolean,
    autorecording: Boolean,
    autoseen: Boolean,
    autoreact: Boolean
}, { collection: 'autosettings' })
const modelFor = (sessionId) => getModel(serverOf(sessionId), 'AutoSettings', schema)

const cache = new Map()      // sessionId -> { alwaysonline, autotyping, autorecording, autoseen }
const pausers = new Map()    // `${sessionId}|${chat}` -> timeout (so "paused" is sent after the LAST message)

const defaults = () => ({
    alwaysonline: false,
    autotyping: !!config.AUTO_TYPING,   // old global config value still works as the default
    autorecording: false,
    autoseen: false,
    autoreact: !!config.AUTO_REACT   // old global config value is the default
})

async function load(sessionId) {
    if (cache.has(sessionId)) return cache.get(sessionId)
    const s = defaults()
    try {
        const doc = await modelFor(sessionId).findOne({ sessionId }).lean()
        if (doc) for (const k of KEYS) if (typeof doc[k] === 'boolean') s[k] = doc[k]
    } catch (e) {
        console.error('[AUTO] settings read error:', e.message)
        return s                         // do not cache a failed read
    }
    cache.set(sessionId, s)
    return s
}

async function save(sessionId, patch) {
    if (!isConnected(serverOf(sessionId))) throw new Error('Database is offline right now, try again in a moment.')
    await modelFor(sessionId).findOneAndUpdate({ sessionId }, { $set: patch }, { upsert: true })
    const cur = await load(sessionId)
    cache.set(sessionId, { ...cur, ...patch })
}

// sync read for the keep-alive timer (returns the type of presence to send)
const presenceType = (sessionId) => (cache.get(sessionId)?.alwaysonline ? 'available' : 'unavailable')

// put WhatsApp presence in the right state (called on connect and after the command)
async function apply(sock, sessionId) {
    try {
        await load(sessionId)
        await sock.sendPresenceUpdate(presenceType(sessionId), sock.user?.id)
    } catch (e) { /* socket may be closing */ }
}

// called by pair.js for every real chat message (not status broadcasts)
async function onMessage(sock, mek, sessionId) {
    try {
        if (!mek?.key || mek.key.fromMe) return
        const jid = mek.key.remoteJid
        if (!jid || jid === 'status@broadcast') return
        const s = await load(sessionId)

        if (s.autoseen) sock.readMessages([mek.key]).catch(() => {})

        if (s.autoreact && !mek.message?.reactionMessage && Math.random() < REACT_CHANCE) {
            const list = (Array.isArray(config.REACT_EMOJIS) && config.REACT_EMOJIS.length) ? config.REACT_EMOJIS : DEFAULT_EMOJIS
            const emoji = list[Math.floor(Math.random() * list.length)]
            sock.sendMessage(jid, { react: { text: emoji, key: mek.key } }).catch(() => {})
        }

        const mode = s.autorecording ? 'recording' : (s.autotyping ? 'composing' : null)
        if (mode) {
            const k = `${sessionId}|${jid}`
            sock.sendPresenceUpdate(mode, jid).catch(() => {})
            clearTimeout(pausers.get(k))
            pausers.set(k, setTimeout(() => {
                pausers.delete(k)
                sock.sendPresenceUpdate('paused', jid).catch(() => {})
            }, TYPING_MS))
        }
    } catch (e) { /* never break message handling */ }
}

function forget(sessionId) { cache.delete(sessionId) }

const onoff = (v) => (v ? '✅ ON' : '❌ OFF')

function makeCommand(key, extra) {
    cmd({
        pattern: key,
        desc: `${LABEL[key]} on/off. Usage: /${key} on | off`,
        category: 'settings',
        react: extra.react,
        filename: __filename
    },
    async (conn, mek, m, { q, prefix, isOwner, sessionId, reply }) => {
        try {
            if (!isOwner) return reply(OWNER_ONLY)
            const choice = (q || '').trim().toLowerCase()
            const cur = (await load(sessionId))[key]

            if (!choice) {
                return reply(`*${LABEL[key]}*\n│ ✦ ᴄᴜʀʀᴇɴᴛ ➱ *${cur ? 'ON' : 'OFF'}*\n│ ➱ ${prefix}${key} on\n│ ➱ ${prefix}${key} off`)
            }
            if (!['on', 'off'].includes(choice)) return reply(`Invalid option. Use: ${prefix}${key} on  or  ${prefix}${key} off`)

            const want = choice === 'on'
            const patch = { [key]: want }
            let note = ''
            // typing and recording share one presence slot, so only one can be active
            if (want && key === 'autotyping') { patch.autorecording = false; note = '\n(Auto Recording turned OFF)' }
            if (want && key === 'autorecording') { patch.autotyping = false; note = '\n(Auto Typing turned OFF)' }

            if (want === cur && !note) return reply(`${LABEL[key]} is already *${choice.toUpperCase()}*.`)
            await save(sessionId, patch)
            if (key === 'alwaysonline') await apply(conn, sessionId)
            reply(`${LABEL[key]} is now *${choice.toUpperCase()}*${note}`)
        } catch (e) {
            console.log('[AUTO]', e)
            reply(`${e.message || e}`)
        }
    })
}

makeCommand('alwaysonline', { react: '🟢' })
makeCommand('autotyping', { react: '⌨️' })
makeCommand('autorecording', { react: '🎙️' })
makeCommand('autoseen', { react: '👁️' })
makeCommand('autoreact', { react: '😍' })

cmd({
    pattern: 'autostatus',
    alias: ['autosettings'],
    desc: 'Show always online / auto typing / auto recording / auto seen / auto react status.',
    category: 'settings',
    react: '📊',
    filename: __filename
},
async (conn, mek, m, { prefix, isOwner, sessionId, reply }) => {
    try {
        if (!isOwner) return reply(OWNER_ONLY)
        const s = await load(sessionId)
        reply(
            `*ᴀᴜᴛᴏ ꜱᴇᴛᴛɪɴɢꜱ*\n\n` +
            KEYS.map(k => `│ ✦ ${LABEL[k]} ➱ ${onoff(s[k])}`).join('\n') +
            `\n\nChange with: ${prefix}alwaysonline on | ${prefix}autotyping on | ${prefix}autorecording on | ${prefix}autoseen on | ${prefix}autoreact on`
        )
    } catch (e) {
        console.log('[AUTO]', e)
        reply(`${e.message || e}`)
    }
})

module.exports = { load, apply, presenceType, onMessage, forget }
