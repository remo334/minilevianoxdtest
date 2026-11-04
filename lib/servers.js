//Xeno Exe
const config = require('../config');
const db = require('./db');

const assignment = new Map();
const persisted = new Set();
const claims = new Map();
const CLAIM_MS = 3 * 60 * 1000;
let isActive = () => false;

const ids = () => db.serverIds().filter(n => config.SERVERS && config.SERVERS[n]);
const exists = (n) => ids().includes(Number(n));
const name = (n) => (config.SERVERS?.[n]?.name) || ('Server ' + n);

function limit(n) {
    const env = parseInt(process.env['MAX_BOTS_' + n], 10);
    if (env > 0) return env;
    const v = parseInt(config.SERVERS?.[n]?.maxBots, 10);
    return v > 0 ? v : 50;
}

const serverOf = (sessionId) => assignment.get(sessionId) || 1;
const assigned = (sessionId) => assignment.get(sessionId);
const assign = (sessionId, n) => { assignment.set(sessionId, Number(n)); };
const markPersisted = (sessionId) => { persisted.add(sessionId); };
const isPersisted = (sessionId) => persisted.has(sessionId);

function counted(sessionId) {
    if (persisted.has(sessionId) || isActive(sessionId)) return true;
    const t = claims.get(sessionId);
    return !!t && Date.now() - t < CLAIM_MS;
}

function count(n) {
    let c = 0;
    for (const [id, srv] of assignment) if (srv === n && counted(id)) c++;
    return c;
}

const isFull = (n) => count(n) >= limit(n);

function claim(sessionId, n) { assign(sessionId, n); claims.set(sessionId, Date.now()); }

function release(sessionId) {
    claims.delete(sessionId);
    if (!persisted.has(sessionId) && !isActive(sessionId)) assignment.delete(sessionId);
}

function forget(sessionId) { claims.delete(sessionId); persisted.delete(sessionId); assignment.delete(sessionId); }

function list() {
    return ids().map(n => {
        const c = count(n), l = limit(n);
        return { id: n, name: name(n), available: db.isConnected(n), count: c, limit: l, full: c >= l };
    });
}

module.exports = { ids, exists, name, limit, serverOf, assigned, assign, markPersisted, isPersisted, counted, count, isFull, claim, release, forget, list, setActiveChecker: (fn) => { isActive = fn; } };
