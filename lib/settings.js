//Xeno Exe
const mongoose = require('mongoose');
const config = require('../config');
const { isConnected, getModel } = require('./db');
const { serverOf } = require('./servers');

const schema = new mongoose.Schema({
    sessionId: { type: String, unique: true, index: true },
    botName: String,
    menuUrl: String,
    botInfo: String,
    mode: String,
    prefix: String,
    mention: String,
    caption: String,
    antidelete: String,
    antiedit: String
});
const modelFor = (sessionId) => getModel(serverOf(sessionId), 'BotSettings', schema);

const cache = {};

function defaults() {
    return { botName: config.BOT_NAME, menuUrl: config.MENU_URL, botInfo: config.BOT_INFO, mode: config.MODE === 'private' ? 'private' : 'public', prefix: config.PREFIX, mention: 'on', caption: '', antidelete: 'off', antiedit: 'off' };
}

async function getSettings(sessionId) {
    if (cache[sessionId]) return cache[sessionId];
    let doc = null;
    let readFailed = false;
    try { doc = await modelFor(sessionId).findOne({ sessionId }).lean(); } catch (e) { readFailed = true; console.error('Settings read error:', e.message); }
    const d = defaults();
    const merged = {
        botName: doc?.botName || d.botName,
        menuUrl: doc?.menuUrl || d.menuUrl,
        botInfo: doc?.botInfo || d.botInfo,
        mode: doc?.mode || d.mode,
        prefix: doc?.prefix || d.prefix,
        mention: doc?.mention || d.mention,
        caption: doc?.caption || d.caption,
        antidelete: doc?.antidelete || d.antidelete,
        antiedit: doc?.antiedit || d.antiedit
    };
    if (!readFailed) cache[sessionId] = merged;
    return merged;
}

async function setSetting(sessionId, key, value) {
    if (!['botName', 'menuUrl', 'botInfo', 'mode', 'prefix', 'mention', 'caption', 'antidelete', 'antiedit'].includes(key)) throw new Error('Invalid setting key');
    if (key === 'antidelete' && !['off', 'chat', 'inbox'].includes(value)) throw new Error('Invalid antidelete mode');
    if (key === 'antiedit' && !['on', 'off'].includes(value)) throw new Error('Invalid antiedit mode');
    if (key === 'mode' && !['public', 'private'].includes(value)) throw new Error('Invalid mode');
    if (!isConnected(serverOf(sessionId))) throw new Error('Database is offline right now, try again in a moment.');
    await modelFor(sessionId).findOneAndUpdate({ sessionId }, { $set: { [key]: value } }, { upsert: true });
    delete cache[sessionId];
}

async function resetSettings(sessionId) {
    await modelFor(sessionId).deleteOne({ sessionId });
    delete cache[sessionId];
}

module.exports = { getSettings, setSetting, resetSettings };
