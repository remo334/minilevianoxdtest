//Xeno Exe
const mongoose = require('mongoose');
const { isConnected, getModel } = require('./db');
const { serverOf } = require('./servers');

const schema = new mongoose.Schema({
    sessionId: { type: String, index: true },
    groupId: { type: String, index: true },
    antilink: { type: mongoose.Schema.Types.Mixed, default: {} },
    welcome: { type: mongoose.Schema.Types.Mixed, default: {} },
    goodbye: { type: mongoose.Schema.Types.Mixed, default: {} },
    anti: { type: mongoose.Schema.Types.Mixed, default: {} },
    warns: { type: mongoose.Schema.Types.Mixed, default: {} },
    warnLimit: { type: Number, default: 3 }
});
schema.index({ sessionId: 1, groupId: 1 }, { unique: true });

const modelFor = (sessionId) => getModel(serverOf(sessionId), 'GroupSettings', schema);
const cache = new Map();
const key = (s, g) => s + '|' + g;

const blank = () => ({ antilink: {}, anti: {}, welcome: {}, goodbye: {}, warns: {}, warnLimit: 3 });

async function getGroup(sessionId, groupId) {
    const k = key(sessionId, groupId);
    if (cache.has(k)) return cache.get(k);
    let doc = null, failed = false;
    try { doc = await modelFor(sessionId).findOne({ sessionId, groupId }).lean(); }
    catch (e) { failed = true; console.error('Group settings read error:', e.message); }
    const data = { ...blank(), ...(doc || {}) };
    for (const f of ['antilink', 'anti', 'welcome', 'goodbye', 'warns']) data[f] = data[f] || {};
    if (!failed) cache.set(k, data);
    return data;
}

async function setGroupField(sessionId, groupId, field, value) {
    if (!['antilink', 'anti', 'welcome', 'goodbye', 'warns', 'warnLimit'].includes(field)) throw new Error('Invalid group setting');
    if (!isConnected(serverOf(sessionId))) throw new Error('Database is offline right now, try again in a moment.');
    await modelFor(sessionId).findOneAndUpdate({ sessionId, groupId }, { $set: { [field]: value } }, { upsert: true });
    cache.delete(key(sessionId, groupId));
}

async function updateGroupObject(sessionId, groupId, field, patch) {
    const g = await getGroup(sessionId, groupId);
    await setGroupField(sessionId, groupId, field, { ...(g[field] || {}), ...patch });
}

async function addWarn(sessionId, groupId, number) {
    const g = await getGroup(sessionId, groupId);
    const warns = { ...(g.warns || {}) };
    warns[number] = (warns[number] || 0) + 1;
    await setGroupField(sessionId, groupId, 'warns', warns);
    return { count: warns[number], limit: g.warnLimit || 3 };
}

async function resetWarn(sessionId, groupId, number) {
    const g = await getGroup(sessionId, groupId);
    const warns = { ...(g.warns || {}) };
    delete warns[number];
    await setGroupField(sessionId, groupId, 'warns', warns);
}

module.exports = { getGroup, setGroupField, updateGroupObject, addWarn, resetWarn };
