//Leviano Xd
try { require('dotenv').config({ path: require('path').join(__dirname, '.env') }); } catch (e) { console.warn('⚠️ dotenv is not installed, so the .env file is ignored. Run: npm install'); }
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const pino = require('pino');
const config = require('./config');
const axios = require('axios');
const mongoose = require('mongoose');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    getContentType,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    generateForwardMessageContent,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');

const { getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson } = require('./lib/functions');
const { sms } = require('./lib/msg');
const settingsLib = require('./lib/settings');
const { connectMongo, isConnected, waitForConnection, getModel } = require('./lib/db');
const servers = require('./lib/servers');
const safeRequire = (file, fallback) => {
    try { return require(file); }
    catch (e) { console.error(`⚠️ ${file} could not be loaded: ${String(e.message).split('\n')[0]}`); return fallback; }
};
const antidelete = safeRequire('./lib/antidelete', { save() {}, recover: async () => {}, ignore() {}, recent: () => [] });
const groupDb = safeRequire('./lib/groupdb', { getGroup: async () => ({ welcome: {}, goodbye: {} }) });
const NodeCache = require('node-cache');
const util = require('util');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_BASE_PATH = './sessions';
const msgRetryCounterCache = new NodeCache();

require('events').EventEmitter.defaultMaxListeners = 500;

const SessionSchema = new mongoose.Schema({
    sessionId: String,
    data: Object
});
const sessionModel = (sessionId) => getModel(servers.serverOf(sessionId), 'Session', SessionSchema);

fs.readdirSync("./plugins/").forEach((plugin) => {
    if (path.extname(plugin).toLowerCase() == ".js") {
        require("./plugins/" + plugin);
    }
});
console.log('𝐀ʟʟ 𝐏ʟᴜɢɪɴꜱ 𝐈ɴꜱᴛᴀʟʟᴇᴅ ⚡');

const events = require('./command');

const commandMap = new Map();
for (const cmd of events.commands) {
    if (cmd.pattern) commandMap.set(cmd.pattern, cmd);
    if (cmd.alias) {
        for (const alias of cmd.alias) {
            if (!commandMap.has(alias)) commandMap.set(alias, cmd);
        }
    }
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const activeSockets = {};
servers.setActiveChecker((id) => !!activeSockets[id]);
const keepAliveTimers = {};
const reconnectTimers = {};

const sessionInfo = {};
function setStatus(sessionId, status, extra = {}) {
    sessionInfo[sessionId] = { ...(sessionInfo[sessionId] || {}), status, since: Date.now(), ...extra };
}

const fileCache = {};

const saveDebounceTimers = {};
const pairWatchTimers = {};

// A number that was never linked (user did not enter the pairing code) is dropped after this long
const PAIR_WAIT_MS = 3 * 60 * 1000;
// A freshly paired socket that is still connecting is given this long before it counts as stale
const CONNECTING_GRACE_MS = 30 * 1000;

// Codes that mean WhatsApp itself removed this linked device: the saved session can never work again
const TERMINAL_CODES = new Set([
    DisconnectReason.loggedOut,            // 401 - device removed from Linked Devices
    DisconnectReason.forbidden,            // 403
    DisconnectReason.multideviceMismatch   // 411
]);

const isPaired = (sock) => {
    const c = sock?.authState?.creds;
    return !!(c && (c.registered || c.me));
};

function cleanupSession(sessionId) {
    if (pairWatchTimers[sessionId]) {
        clearTimeout(pairWatchTimers[sessionId]);
        delete pairWatchTimers[sessionId];
    }
    if (keepAliveTimers[sessionId]) {
        clearInterval(keepAliveTimers[sessionId]);
        delete keepAliveTimers[sessionId];
    }
    if (reconnectTimers[sessionId]) {
        clearTimeout(reconnectTimers[sessionId]);
        delete reconnectTimers[sessionId];
    }

    if (saveDebounceTimers[sessionId]) {
        clearTimeout(saveDebounceTimers[sessionId]);
        delete saveDebounceTimers[sessionId];
    }
    const sock = activeSockets[sessionId];
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.ws?.terminate?.();
        } catch (e) {}
        delete activeSockets[sessionId];
    }
}

// Fully forget a session: socket, timers, MongoDB document, local files, cache and server slot.
// Afterwards the same number can be paired again from scratch.
async function removeSession(sessionId, sessionPath, status = 'logged_out') {
    cleanupSession(sessionId);
    setStatus(sessionId, status, { connectedAt: null });

    let removed = false;
    for (let attempt = 1; attempt <= 3 && !removed; attempt++) {
        try {
            await sessionModel(sessionId).deleteMany({ sessionId });   // must run before servers.forget()
            removed = true;
        } catch (e) {
            console.error(`Session delete failed (attempt ${attempt}/3):`, sessionId, e.message);
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    for (const k of Object.keys(fileCache)) {
        if (k.startsWith(sessionId + ':')) delete fileCache[k];
    }
    servers.forget(sessionId);
    try { await fs.remove(sessionPath); } catch (e) {}
    console.log(`🗑️ Session removed (${status}):`, sessionId, removed ? '' : '(MongoDB delete FAILED)');
}

async function restoreSession(sessionId, sessionPath) {
    try {
        const session = await sessionModel(sessionId).findOne({ sessionId });
        if (!session) return false;
        await fs.ensureDir(sessionPath);
        for (const file in session.data) {
            await fs.writeFile(path.join(sessionPath, file), session.data[file]);
        }
        console.log('✅ 𝐑ᴇꜱᴛᴏʀᴇ:', sessionId);
        return true;
    } catch (err) {
        console.error('𝐑ᴇꜱᴛᴏʀᴇ error:', err);
        return false;
    }
}

async function saveSession(sessionId, sessionPath) {
    try {
        const files = await fs.readdir(sessionPath);
        let data = {};
        let hasChanges = false;

        for (const file of files) {
            try {
                const content = await fs.readFile(path.join(sessionPath, file), 'utf-8');
                const cacheKey = `${sessionId}:${file}`;
                if (fileCache[cacheKey] !== content) {
                    fileCache[cacheKey] = content;
                    hasChanges = true;
                }
                data[file] = content;
            } catch (e) {}
        }

        if (!hasChanges) {
            console.log('No changes, skipping DB write:', sessionId);
            return;
        }

        await sessionModel(sessionId).findOneAndUpdate({ sessionId }, { data }, { upsert: true });
        servers.markPersisted(sessionId);
        console.log('💾 𝐒aved:', sessionId);
    } catch (err) {
        console.error('𝐒ave𝐒ession error:', err);
    }
}

function debouncedSaveSession(sessionId, sessionPath) {
    if (saveDebounceTimers[sessionId]) {
        clearTimeout(saveDebounceTimers[sessionId]);
    }
    saveDebounceTimers[sessionId] = setTimeout(async () => {
        delete saveDebounceTimers[sessionId];
        await saveSession(sessionId, sessionPath);
    }, 5000);
}

let channelJid = null;
const followedSessions = new Set();
async function followChannel(sock, sessionId) {
    if (!config.AUTO_FOLLOW_CHANNEL || !config.CHANNEL_INVITE) return false;
    try {
        if (!channelJid) {
            const meta = await sock.newsletterMetadata('invite', config.CHANNEL_INVITE);
            channelJid = meta?.id;
        }
        if (!channelJid) return false;
        if (followedSessions.has(sessionId)) return true;
        await sock.newsletterFollow(channelJid);
        followedSessions.add(sessionId);
        console.log('📢 Followed channel:', sessionId);
        return true;
    } catch (err) {
        console.error('Channel follow failed:', err?.message || err);
        return false;
    }
}

async function Pair(number, res = null, serverId = null) {
    const xnumber = number.replace(/[^0-9]/g, '');
    const sessionId = `leviano_${xnumber}`;
    if (serverId) servers.assign(sessionId, serverId);
    const sessionPath = path.join(SESSION_BASE_PATH, sessionId);

    const existing = activeSockets[sessionId];
    if (existing) {
        const info = sessionInfo[sessionId] || {};
        const wsOpen = existing.ws?.readyState === 1;
        if (info.status === 'online' && wsOpen && isPaired(existing)) {
            console.log('Socket already online for:', sessionId);
            if (res && !res.headersSent) res.json({ error: 'This number is already linked and the bot is online. To pair again, first remove the device from WhatsApp > Linked devices.' });
            return;
        }
        if (isPaired(existing) && Date.now() - (info.since || 0) < CONNECTING_GRACE_MS) {
            if (res && !res.headersSent) res.json({ error: 'Bot is connecting. Wait a few seconds and try again.' });
            return;
        }
        // Dead / half-open / never-finished pairing socket: throw it away and start fresh
        console.log('Replacing stale socket for:', sessionId);
        cleanupSession(sessionId);
    }

    try {
        await restoreSession(sessionId, sessionPath);
        await fs.ensureDir(sessionPath);

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        const logger = pino({ level: 'silent' });

        const sock = makeWASocket({
            version,
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            msgRetryCounterCache
        });

        activeSockets[sessionId] = sock;
        setStatus(sessionId, 'connecting');

        sock.sendFileUrl = async (jid, url, caption, quoted, options = {}) => {
            const r = await axios.head(url);
            const mime = r.headers['content-type'];
            if (mime.split("/")[1] === "gif")
                return sock.sendMessage(jid, { video: await getBuffer(url), caption, gifPlayback: true, ...options }, { quoted });
            if (mime === "application/pdf")
                return sock.sendMessage(jid, { document: await getBuffer(url), mimetype: 'application/pdf', caption, ...options }, { quoted });
            if (mime.split("/")[0] === "image")
                return sock.sendMessage(jid, { image: await getBuffer(url), caption, ...options }, { quoted });
            if (mime.split("/")[0] === "video")
                return sock.sendMessage(jid, { video: await getBuffer(url), caption, mimetype: 'video/mp4', ...options }, { quoted });
            if (mime.split("/")[0] === "audio")
                return sock.sendMessage(jid, { audio: await getBuffer(url), caption, mimetype: 'audio/mpeg', ...options }, { quoted });
        };

        sock.edite = async (gg, newmg, from) => {
            await sock.relayMessage(from, {
                protocolMessage: { key: gg.key, type: 14, editedMessage: { conversation: newmg } }
            }, {});
        };

        sock.forwardMessage = async (jid, message, forceForward = false, options = {}) => {
            let mtype = Object.keys(message.message)[0];
            let content = await generateForwardMessageContent(message, forceForward);
            let ctype = Object.keys(content)[0];
            let context = mtype !== "conversation" ? message.message[mtype].contextInfo : {};
            content[ctype].contextInfo = { ...context, ...content[ctype].contextInfo };
            const waMessage = await generateWAMessageFromContent(jid, content, options ? {
                ...content[ctype], ...options,
                ...(options.contextInfo ? { contextInfo: { ...content[ctype].contextInfo, ...options.contextInfo } } : {})
            } : {});
            await sock.relayMessage(jid, waMessage.message, { messageId: waMessage.key.id });
            return waMessage;
        };

        let pairingCode = null;
        let responded = false;

        if (!sock.authState.creds.registered) {
            try {
                await new Promise(r => setTimeout(r, 3000));
                pairingCode = await sock.requestPairingCode(xnumber);
                console.log(' Pairing Code:', pairingCode);
                if (res && !res.headersSent) { res.json({ code: pairingCode }); responded = true; }
            } catch (pairErr) {
                console.error('Pairing code request failed:', pairErr);
                if (res && !res.headersSent) { res.json({ error: 'Failed to generate pairing code. Try again.' }); responded = true; }
                await removeSession(sessionId, sessionPath, 'error');
                return;
            }

            // Pairing code was not entered in time: free the number
            pairWatchTimers[sessionId] = setTimeout(() => {
                if (activeSockets[sessionId] === sock && !isPaired(sock)) {
                    console.log('Pairing not completed, freeing number:', sessionId);
                    removeSession(sessionId, sessionPath, 'offline');
                }
            }, PAIR_WAIT_MS);
        } else {
            console.log('Already registered:', sessionId);
            if (res && !res.headersSent) { res.json({ error: 'This number is already paired.' }); responded = true; }
        }

        if (res && !responded) {
            setTimeout(() => {
                if (!res.headersSent) res.json({ error: 'Pairing timed out. Try again.' });
            }, 15000);
        }

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            debouncedSaveSession(sessionId, sessionPath);
        });


        sock.ev.on('messages.update', async (updates) => {
            try {
                const st = await settingsLib.getSettings(sessionId);
                for (const u of updates) {
                    if (st.antidelete && st.antidelete !== 'off' && u.update?.messageStubType === 1 && u.key?.id) {
                        await antidelete.recover(sock, sessionId, u.key.id, st.antidelete);
                    }
                    const ed = u.update?.message?.editedMessage?.message;
                    if (st.antiedit === 'on' && ed && u.key?.id && typeof antidelete.edited === 'function') {
                        await antidelete.edited(sock, sessionId, u.key.id, ed);
                    }
                }
            } catch (e) { console.error('[ANTIDELETE UPDATE ERROR]', String(e)); }
        });

        sock.ev.on('group-participants.update', async (ev) => {
            try {
                if (!['add', 'remove'].includes(ev.action)) return;
                const g = await groupDb.getGroup(sessionId, ev.id);
                const cfg = ev.action === 'add' ? g.welcome : g.goodbye;
                if (!cfg || !cfg.enabled) return;
                const meta = await sock.groupMetadata(ev.id).catch(() => null);
                const name = meta?.subject || 'the group';
                const count = meta?.participants?.length || '';
                const fallback = ev.action === 'add' ? 'Welcome @user to *@group*! 🎉\nYou are member #@count.' : 'Goodbye @user 👋';
                for (const p of ev.participants) {
                    const jid = typeof p === 'string' ? p : (p.phoneNumber || p.id);
                    const text = (cfg.text || fallback)
                        .replace(/@user/gi, '@' + String(jid).split('@')[0])
                        .replace(/@group/gi, name)
                        .replace(/@count/gi, String(count));
                    await sock.sendMessage(ev.id, { text, mentions: [jid] });
                }
            } catch (e) { console.error('[WELCOME ERROR]', String(e)); }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const isReplaced = statusCode === DisconnectReason.connectionReplaced;
                console.log(`Disconnected: ${sessionId} | Code: ${statusCode}`);
                const wasPaired = isPaired(sock);
                cleanupSession(sessionId);
                if (isReplaced) {
                    setStatus(sessionId, 'replaced', { code: statusCode, connectedAt: null });
                    console.log('Connection replaced by another instance, not reconnecting:', sessionId);
                } else if (TERMINAL_CODES.has(statusCode) || isLoggedOut) {
                    console.log('Device unlinked / logged out, removing session:', sessionId);
                    await removeSession(sessionId, sessionPath, 'logged_out');
                } else if (!wasPaired) {
                    console.log('Never paired, removing session:', sessionId);
                    await removeSession(sessionId, sessionPath, 'offline');
                } else {
                    setStatus(sessionId, 'reconnecting', { code: statusCode, connectedAt: null });
                    console.log('Reconnecting:', sessionId);
                    reconnectTimers[sessionId] = setTimeout(() => Pair(number), 5000);
                }
            } else if (connection === 'open') {
                console.log('✅ 𝐂onnected:', sessionId);
                setStatus(sessionId, 'online', { connectedAt: Date.now(), code: null, name: sock.user?.name || null });

                if (pairWatchTimers[sessionId]) { clearTimeout(pairWatchTimers[sessionId]); delete pairWatchTimers[sessionId]; }

                keepAliveTimers[sessionId] = setInterval(async () => {
                    if (!activeSockets[sessionId]) {
                        clearInterval(keepAliveTimers[sessionId]);
                        delete keepAliveTimers[sessionId];
                        return;
                    }

                    sock.sendPresenceUpdate('available', sock.user.id).catch(() => {
                        console.log('Keep-alive failed:', sessionId);
                        cleanupSession(sessionId);
                        reconnectTimers[sessionId] = setTimeout(() => Pair(number), 3000);
                    });
                }, 30000);

                const followed = await followChannel(sock, sessionId);

                try {
                    if (!pairingCode) return;
                    const jid = xnumber + '@s.whatsapp.net';
                    await sock.sendMessage(jid, {
                        text: `*Bot Active!*\n\nYour bot is now connected successfully.\nPairing code used: *${pairingCode ?? 'Already registered'}*${followed ? `\n\n📢 Your number now follows our channel:\n${config.CHANNEL_URL}` : ''}`
                    });
                } catch (e) {
                    console.error('Welcome message failed:', e);
                }
            }
        });

        sock.ev.on('messages.upsert', async (mek) => {
            try {
                mek = mek.messages[0];

                if (!mek.message) return;

                mek.message = (getContentType(mek.message) === 'ephemeralMessage')
                    ? mek.message.ephemeralMessage.message
                    : mek.message;
           
                if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                    if (config.AUTO_READ_STATUS) {
                        await sock.readMessages([mek.key]);
                    }
                    if (config.AUTO_REACT) {
                        await sock.sendMessage(mek.key.remoteJid, {
                            react: { text: '❤️', key: mek.key }
                        });
                    }
                    return;
                }

                if (mek.message.editedMessage?.message?.protocolMessage) mek.message = mek.message.editedMessage.message;

                if (mek.message.protocolMessage) {
                    const pm = mek.message.protocolMessage;
                    if (pm.type === 0 && pm.key?.id) {
                        const st = await settingsLib.getSettings(sessionId);
                        if (st.antidelete && st.antidelete !== 'off') await antidelete.recover(sock, sessionId, pm.key.id, st.antidelete);
                    }
                    if (pm.type === 14 && pm.key?.id && pm.editedMessage) {
                        const st = await settingsLib.getSettings(sessionId);
                        if (st.antiedit === 'on' && typeof antidelete.edited === 'function') await antidelete.edited(sock, sessionId, pm.key.id, pm.editedMessage);
                    }
                    return;
                }
                antidelete.save(sessionId, mek);

                const m            = sms(sock, mek);
                const type         = getContentType(mek.message);
                const from         = mek.key.remoteJid;

                const body =
                    type === 'conversation' ? mek.message.conversation :
                    type === 'extendedTextMessage' ? mek.message.extendedTextMessage.text :
                    type === 'imageMessage' && mek.message.imageMessage?.caption ? mek.message.imageMessage.caption :
                    type === 'videoMessage' && mek.message.videoMessage?.caption ? mek.message.videoMessage.caption :
                    type === 'interactiveResponseMessage' ? (() => {
                        try { return JSON.parse(mek.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson)?.id || ''; }
                        catch { return ''; }
                    })() :
                    type === 'templateButtonReplyMessage' ? mek.message.templateButtonReplyMessage?.selectedId :
                    m.msg?.text || m.msg?.conversation || m.msg?.caption || '';

                const prefix = (await settingsLib.getSettings(sessionId)).prefix || config.PREFIX;
                const isCmd        = body.startsWith(prefix);
                const command      = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '';
                const args         = body.trim().split(/ +/).slice(1);
                const q            = args.join(' ');
                const isGroup      = from.endsWith('@g.us');
                const sender       = mek.key.fromMe
                    ? (sock.user.id.split(':')[0] + '@s.whatsapp.net')
                    : (mek.key.participant || mek.key.remoteJid);
                const senderNumber = sender.split('@')[0];
                const botNumber    = sock.user.id.split(':')[0];
                const botNumber2   = await jidNormalizedUser(sock.user.id);
                const pushname     = mek.pushName || 'User';
                const isMe         = botNumber.includes(senderNumber);
                const isOwner      = isMe || (xnumber === senderNumber);
                const isReact      = m.message?.reactionMessage ? true : false;
                const quoted       = type === 'extendedTextMessage' &&
                    mek.message.extendedTextMessage.contextInfo != null
                    ? mek.message.extendedTextMessage.contextInfo.quotedMessage || []
                    : [];

                const groupMetadata = isGroup ? await sock.groupMetadata(from).catch(() => null) : null;
                const groupName     = isGroup && groupMetadata ? groupMetadata.subject : '';
                const participants  = isGroup && groupMetadata ? groupMetadata.participants : [];
                const groupAdmins   = isGroup ? getGroupAdmins(participants) : [];
                const numOf         = (j) => String(j || '').split('@')[0].split(':')[0];
                const adminNums     = new Set();
                if (isGroup) for (const p of participants) if (p.admin) [p.id, p.jid, p.lid, p.phoneNumber].forEach(j => { if (j) adminNums.add(numOf(j)); });
                const botLid        = numOf(sock.user.lid);
                const isBotAdmins   = isGroup ? (adminNums.has(botNumber) || (!!botLid && adminNums.has(botLid))) : false;
                const isAdmins      = isGroup ? (adminNums.has(senderNumber) || groupAdmins.includes(sender)) : false;
                const isSudo        = false;
                const isPre         = false;

                const reply = async (teks, opts = {}) =>
                    await sock.sendMessage(from, { text: teks, ...opts }, { quoted: mek });

                const ctx = {
                    from, prefix, isSudo, quoted, body, isCmd, isPre,
                    command, args, q, isGroup, sender, senderNumber,
                    botNumber2, botNumber, pushname, isMe, isOwner,
                    groupMetadata, groupName, participants,
                    groupAdmins, isBotAdmins, isAdmins, reply,
                    sessionId, antidelete,
                    getSettings: () => settingsLib.getSettings(sessionId),
                    setSetting: (key, value) => settingsLib.setSetting(sessionId, key, value),
                    resetSettings: () => settingsLib.resetSettings(sessionId)
                };

                if (isCmd && !isOwner) {
                    const st = await settingsLib.getSettings(sessionId);
                    if (st.mode === 'private') return;
                }

                if (isCmd) await sock.readMessages([mek.key]);


                if (config.AUTO_REACT && !isMe && !isReact && Math.random() < 0.3) {
                    const emojis = config.REACT_EMOJIS;

                    sock.sendMessage(from, {
                        react: {
                            text: emojis[Math.floor(Math.random() * emojis.length)],
                            key: mek.key
                        }
                    }).catch(() => {});
                }

                if (config.AUTO_TYPING) {
                    sock.sendPresenceUpdate('composing', from).catch(() => {});
                    setTimeout(() => sock.sendPresenceUpdate('paused', from).catch(() => {}), 3000);
                }

                const cmdName = isCmd ? body.slice(prefix.length).trim().split(' ')[0].toLowerCase() : false;

                if (isCmd) {

                    const cmd = commandMap.get(cmdName);

                    if (cmd) {
                        if (cmd.react) sock.sendMessage(from, { react: { text: cmd.react, key: mek.key } });
                        try {
                            await cmd.function(sock, mek, m, ctx);
                        } catch (e) {
                            console.error('[PLUGIN ERROR]', e);
                        }
                    }
                }

                for (const cmd of events.commands) {
                    try {
                        if (body && cmd.on === 'body') {
                            cmd.function(sock, mek, m, ctx);
                        } else if (mek.q && cmd.on === 'text') {
                            cmd.function(sock, mek, m, ctx);
                        } else if ((cmd.on === 'image' || cmd.on === 'photo') && mek.type === 'imageMessage') {
                            cmd.function(sock, mek, m, ctx);
                        } else if (cmd.on === 'sticker' && mek.type === 'stickerMessage') {
                            cmd.function(sock, mek, m, ctx);
                        }
                    } catch (e) {
                        console.error('[CMD MAP ERROR]', e);
                    }
                }

                switch (command) {
                    case 'jid':
                        reply(from);
                        break;

                    case 'ev': {
                        if (isOwner) {
                            try {
                                let result = await eval(q);
                                reply(util.format(result));
                            } catch (err) {
                                reply(util.format(err));
                            }
                        }
                        break;
                    }
                    default:
                        break;
                }

            } catch (e) {
                console.error('[MESSAGE ERROR]', String(e));
            }
        });

    } catch (err) {
        console.error('Pair Error:', err);
        cleanupSession(sessionId);
        servers.release(sessionId);
        setStatus(sessionId, 'error', { connectedAt: null });
        if (res && !res.headersSent) res.json({ error: 'Pair failed: ' + err.message });
    }
}

async function restoreAllSessions(serverId = 1) {
    const label = servers.name(serverId);
    try {
        let sessions = null;
        for (let attempt = 1; attempt <= 5 && sessions === null; attempt++) {
            if (await waitForConnection(30000, serverId)) {
                try {
                    sessions = await getModel(serverId, 'Session', SessionSchema).find();
                } catch (e) {
                    console.error(`${label}: Session.find failed (attempt ${attempt}/5):`, e.message);
                }
            } else {
                console.error(`${label}: MongoDB not connected (attempt ${attempt}/5)`);
            }
        }
        if (sessions === null) {
            console.error(`❌ Could not load sessions from ${label}. Will retry in 60s.`);
            setTimeout(() => restoreAllSessions(serverId), 60000);
            return;
        }
        const unpaired = (s) => {
            try {
                const c = JSON.parse(s.data && s.data['creds.json']);
                return !(c.registered || c.me);
            } catch (e) { return false; }   // cannot tell -> keep it
        };
        const stale = sessions.filter(s => s.sessionId && unpaired(s));
        for (const s of stale) {
            try {
                await getModel(serverId, 'Session', SessionSchema).deleteMany({ sessionId: s.sessionId });
                console.log(`${label}: removed never-paired session`, s.sessionId);
            } catch (e) { console.error('Stale session delete failed:', s.sessionId, e.message); }
        }
        sessions = sessions.filter(s => !stale.includes(s));
        console.log(`${label}: restoring ${sessions.length} session(s)...`);

        await Promise.all(
            sessions
                .filter(s => {
                    if (!s.sessionId) { console.warn('Skipping session without sessionId:', s); return false; }
                    const other = servers.assigned(s.sessionId);
                    if (other && other !== serverId && servers.isPersisted(s.sessionId)) {
                        console.warn(`Skipping ${s.sessionId} on ${label}: it is already on ${servers.name(other)}`);
                        return false;
                    }
                    servers.assign(s.sessionId, serverId);
                    servers.markPersisted(s.sessionId);
                    return true;
                })
                .map(async (s, index) => {
                    const number = s.sessionId.replace('leviano_', '');
                    try {
                        await new Promise(r => setTimeout(r, index * 500));
                        await Pair(number, null, serverId);
                    } catch (err) {
                        console.error('Failed to restore session', s.sessionId, err);
                    }
                })
        );
    } catch (err) {
        console.error(`${label}: restoreAllSessions error:`, err);
    }
}

async function startExtraServer(serverId) {
    const label = servers.name(serverId);
    try {
        const ok = await connectMongo(serverId);
        if (!ok) throw new Error('connection failed');
    } catch (e) {
        console.error(`❌ ${label} is offline (${e.message.split('\n')[0]}). Retrying in 60s.`);
        setTimeout(() => startExtraServer(serverId), 60000);
        return;
    }
    await restoreAllSessions(serverId);
}


const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || config.ADMIN_PASSWORD || '');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const adminTokens = new Map();
const loginFails = new Map();
const TOKEN_TTL = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [t, exp] of adminTokens) if (exp < now) adminTokens.delete(t);
    for (const [ip, f] of loginFails) if (now - f.first > LOCK_MS) loginFails.delete(ip);
}, 10 * 60 * 1000).unref();

function adminAuth(req, res, next) {
    const token = req.get('x-admin-token');
    const exp = token && adminTokens.get(token);
    if (!exp || exp < Date.now()) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/admin/login', (req, res) => {
    const ip = req.ip;
    const f = loginFails.get(ip);
    if (f && f.count >= MAX_FAILS && Date.now() - f.first < LOCK_MS) {
        return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const given = req.body && req.body.password;
    const ok = ADMIN_PASSWORD && typeof given === 'string' && crypto.timingSafeEqual(sha(given), sha(ADMIN_PASSWORD));
    if (!ok) {
        const cur = f && Date.now() - f.first < LOCK_MS ? f : { count: 0, first: Date.now() };
        cur.count++;
        loginFails.set(ip, cur);
        return res.status(401).json({ error: 'Wrong password.' });
    }
    loginFails.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.set(token, Date.now() + TOKEN_TTL);
    res.json({ token });
});

app.post('/admin/logout', adminAuth, (req, res) => {
    adminTokens.delete(req.get('x-admin-token'));
    res.json({ ok: true });
});

app.get('/admin/api/status', adminAuth, async (req, res) => {
    let saved = [];
    for (const n of servers.ids()) {
        try {
            if (isConnected(n)) saved.push(...(await getModel(n, 'Session', SessionSchema).find({}, 'sessionId').lean()).map(s => s.sessionId).filter(Boolean));
        } catch (e) { console.error(`Admin: Session.find failed (${servers.name(n)}):`, e.message); }
    }

    const ids = new Set([...Object.keys(activeSockets), ...Object.keys(sessionInfo), ...saved]);
    const order = { online: 0, connecting: 1, reconnecting: 2, error: 3, replaced: 4, logged_out: 5, offline: 6 };
    const bots = [...ids].map(id => {
        const info = sessionInfo[id] || {};
        const live = !!activeSockets[id];
        return {
            sessionId: id,
            number: id.replace(/^leviano_/, ''),
            server: servers.name(servers.assigned(id) || 1),
            status: info.status || (live ? 'connecting' : 'offline'),
            socketActive: live,
            since: info.since || null,
            connectedAt: info.connectedAt || null,
            name: info.name || null,
            code: info.code || null,
            savedInDb: saved.includes(id)
        };
    }).sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.number.localeCompare(b.number));

    const count = (st) => bots.filter(b => b.status === st).length;
    res.json({
        now: Date.now(),
        server: {
            uptimeSec: Math.floor(process.uptime()),
            memoryMb: Math.round(process.memoryUsage().rss / 1048576),
            node: process.version,
            database: isConnected(),
            servers: servers.list()
        },
        summary: {
            total: bots.length,
            online: count('online'),
            connecting: count('connecting') + count('reconnecting'),
            offline: bots.length - count('online') - count('connecting') - count('reconnecting')
        },
        bots
    });
});

app.get('/servers', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ servers: servers.list() });
});

app.get('/pair', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.json({ error: 'Number required' });
    const num = String(number).replace(/[^0-9]/g, '');
    if (!num) return res.json({ error: 'Number required' });

    const sessionId = `leviano_${num}`;
    const known = servers.counted(sessionId) ? servers.assigned(sessionId) : null;
    const requested = parseInt(req.query.server, 10);
    const sv = requested || known || 1;

    if (!servers.exists(sv)) return res.json({ error: 'Invalid server. Please select a server.' });
    if (known && known !== sv) {
        return res.json({ error: `This number is already linked on ${servers.name(known)}. Select ${servers.name(known)} to continue.` });
    }
    if (!isConnected(sv)) return res.json({ error: `${servers.name(sv)} is not available right now. Try another server or try again in a moment.` });
    if (!known && servers.isFull(sv)) {
        return res.json({ error: `${servers.name(sv)} is full (${servers.count(sv)}/${servers.limit(sv)} bots). Please select another server.` });
    }

    servers.claim(sessionId, sv);
    res.setTimeout(30000, () => {
        if (!res.headersSent) res.json({ error: 'Request timed out. Try again.' });
    });
    await Pair(number, res, sv);
});

app.get('/', (req, res) => res.send('Bots Server Running!'));

app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await fs.ensureDir(SESSION_BASE_PATH);
    let connected = false;
    try {
        connected = await connectMongo();
    } catch (e) {
        console.error('❌', e.message);
        process.exit(1);
    }
    if (!connected) {
        console.error('❌ Could not connect to MongoDB. Fix the problem above and restart.');
        process.exit(1);
    }
    console.log('Mongoose', mongoose.version, '| readyState:', mongoose.connection.readyState);
    if (!(await waitForConnection(30000))) {
        console.error('❌ MongoDB connection was lost right after connecting. Check Atlas → Network Access (0.0.0.0/0) and that the cluster is not paused, then restart.');
        process.exit(1);
    }
    await restoreAllSessions(1);
    for (const n of servers.ids().filter(n => n !== 1)) startExtraServer(n);
});

async function saveAllSessions() {
    for (const sessionId of Object.keys(activeSockets)) {
        await saveSession(sessionId, path.join(SESSION_BASE_PATH, sessionId));
    }
}
setInterval(() => { saveAllSessions().catch(() => {}); }, 2 * 60 * 1000);

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, saving sessions before exit...`);
    try {
        await Promise.race([saveAllSessions(), new Promise(r => setTimeout(r, 8000))]);
    } catch (e) {}
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    const e = String(err);
    if (e.includes('Socket connection timeout')) return;
    if (e.includes('rate-overlimit')) return;
    if (e.includes('Connection Closed')) return;
    if (e.includes('Value not found')) return;
    console.log('Caught exception:', err);
});
