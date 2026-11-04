//Leviano Xd
const { downloadContentFromMessage, getContentType, jidNormalizedUser } = require('@whiskeysockets/baileys');

const MAX_PER_SESSION = 1500;
const MAX_AGE = 2 * 60 * 60 * 1000;
const store = new Map();
const handled = new Map();

const bucket = (map, sessionId) => { if (!map.has(sessionId)) map.set(sessionId, new Map()); return map.get(sessionId); };

function save(sessionId, mek) {
    if (!mek?.key?.id || !mek.message) return;
    const b = bucket(store, sessionId);
    b.set(mek.key.id, { msg: mek, time: Date.now() });
    if (b.size > MAX_PER_SESSION) b.delete(b.keys().next().value);
}

function ignore(sessionId, id) { bucket(handled, sessionId).set(id, Date.now()); }

setInterval(() => {
    const now = Date.now();
    for (const b of store.values()) for (const [id, v] of b) if (now - v.time > MAX_AGE) b.delete(id);
    for (const b of handled.values()) for (const [id, t] of b) if (now - t > MAX_AGE) b.delete(id);
}, 10 * 60 * 1000).unref();

const unwrap = (message) => {
    let msg = message;
    for (let i = 0; i < 4 && msg; i++) {
        const t = getContentType(msg);
        if (['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'].includes(t)) msg = msg[t]?.message;
        else break;
    }
    return msg;
};

async function download(content, kind) {
    const stream = await downloadContentFromMessage(content, kind);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

async function recover(sock, sessionId, deletedId, mode) {
    const done = bucket(handled, sessionId);
    if (done.has(deletedId)) return;
    const entry = bucket(store, sessionId).get(deletedId);
    if (!entry) return;
    done.set(deletedId, Date.now());

    const orig = entry.msg;
    if (orig.key.fromMe) return;

    const chat = orig.key.remoteJid;
    const isGroup = chat.endsWith('@g.us');
    const sender = orig.key.participant || chat;
    const target = mode === 'inbox' ? jidNormalizedUser(sock.user.id) : chat;

    let where = 'Private chat';
    if (isGroup) { try { where = (await sock.groupMetadata(chat)).subject; } catch { where = 'Group'; } }
    const when = new Date((Number(orig.messageTimestamp) || Math.floor(entry.time / 1000)) * 1000).toLocaleString('en-GB', { hour12: true });
    const header = `🗑️ *Deleted message recovered*\n👤 From: @${sender.split('@')[0]}\n💬 Chat: ${where}\n🕒 Sent: ${when}`;
    const mentions = [sender];

    const content = unwrap(orig.message);
    const type = content ? getContentType(content) : null;
    if (!type) return;
    const c = content[type];

    try {
        if (type === 'conversation' || type === 'extendedTextMessage') {
            const text = type === 'conversation' ? c : c.text;
            return await sock.sendMessage(target, { text: `${header}\n\n${text}`, mentions });
        }
        const cap = (c?.caption ? `\n\n${c.caption}` : '');
        if (type === 'imageMessage') return await sock.sendMessage(target, { image: await download(c, 'image'), caption: header + cap, mentions });
        if (type === 'videoMessage') return await sock.sendMessage(target, { video: await download(c, 'video'), caption: header + cap, mentions, gifPlayback: !!c.gifPlayback });
        if (type === 'documentMessage') {
            await sock.sendMessage(target, { document: await download(c, 'document'), mimetype: c.mimetype, fileName: c.fileName || 'file', caption: header + cap, mentions });
            return;
        }
        if (type === 'audioMessage') {
            await sock.sendMessage(target, { text: header + '\n\n🎧 Voice / audio message:', mentions });
            return await sock.sendMessage(target, { audio: await download(c, 'audio'), mimetype: c.mimetype || 'audio/mpeg', ptt: !!c.ptt });
        }
        if (type === 'stickerMessage') {
            await sock.sendMessage(target, { text: header + '\n\n🏷️ Sticker:', mentions });
            return await sock.sendMessage(target, { sticker: await download(c, 'sticker') });
        }
        if (type === 'contactMessage') return await sock.sendMessage(target, { text: `${header}\n\n👤 Contact: ${c.displayName || ''}`, mentions });
        if (type === 'locationMessage') return await sock.sendMessage(target, { text: `${header}\n\n📍 Location`, mentions });
        await sock.sendMessage(target, { text: `${header}\n\n[${type.replace('Message', '')}]`, mentions });
    } catch (e) {
        console.error('Antidelete send failed:', e?.message || e);
        sock.sendMessage(target, { text: `${header}\n\n(${type.replace('Message', '')} could not be recovered)`, mentions }).catch(() => {});
    }
}

function recent(sessionId, chat, { sender = null, limit = 10, skipId = null } = {}) {
    const out = [];
    const all = [...bucket(store, sessionId).values()].reverse();
    const gone = bucket(handled, sessionId);
    for (const { msg } of all) {
        if (out.length >= limit) break;
        const k = msg.key;
        if (k.remoteJid !== chat || k.fromMe || k.id === skipId || gone.has(k.id)) continue;
        if (sender && String(k.participant || '').split('@')[0].split(':')[0] !== sender) continue;
        out.push(k);
    }
    return out;
}

async function edited(sock, sessionId, editedId, newMessage) {
    const entry = bucket(store, sessionId).get(editedId);
    if (!entry) return;
    const orig = entry.msg;
    if (orig.key.fromMe) return;

    const oldContent = unwrap(orig.message);
    const oldType = oldContent ? getContentType(oldContent) : null;
    const textOf = (content, type) => !type ? '' : type === 'conversation' ? content.conversation : (content[type]?.text || content[type]?.caption || '');
    const oldText = textOf(oldContent, oldType);

    const newContent = unwrap(newMessage);
    const newType = newContent ? getContentType(newContent) : null;
    const newText = textOf(newContent, newType);

    entry.msg = { ...orig, message: newMessage };
    if (!oldText || oldText === newText) return;

    const chat = orig.key.remoteJid;
    const sender = orig.key.participant || chat;
    const text = `✏️ *Edited message detected*\n👤 From: @${sender.split('@')[0]}\n\n❌ *Before:*\n${oldText}\n\n✅ *After:*\n${newText}`;
    await sock.sendMessage(chat, { text, mentions: [sender] });
}

module.exports = { save, recover, ignore, recent, edited };
