//Xeno Exe
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const DB_NAME = 'xenobot';
const SERVER_DEFS = {
    1: { uriEnv: 'MONGODB_URI',  passEnv: 'MONGODB_PASSWORD',  defaultUri: 'mongodb+srv://hongtungvuychmong7367_db_user:nickmdbot2255@leviano-xd.vfzlwws.mongodb.net/leviano?retryWrites=true&w=majority' },
    2: { uriEnv: 'MONGODB2_URI', passEnv: 'MONGODB2_PASSWORD', defaultUri: 'mongodb+srv://adithyanrb9_db_user:<db_password>@cluster1.qjpje6a.mongodb.net/' }
};
const serverIds = () => Object.keys(SERVER_DEFS).map(Number);
const conns = { 1: mongoose.connection };

function missingPasswordMessage(passEnv = 'MONGODB_PASSWORD') {
    const root = path.join(__dirname, '..');
    const envFile = path.join(root, '.env');
    let dotenvInstalled = true;
    try { require.resolve('dotenv'); } catch (e) { dotenvInstalled = false; }

    let why;
    if (!fs.existsSync(envFile)) {
        why = `No ".env" file found. It must be here: ${envFile}\n` +
              `   -> Rename ".env.example" to ".env" (or create a new file named .env) and set:  ${passEnv}=your_password\n` +
              `   -> OR, on a host (Railway / Render / Heroku / panel), add ${passEnv} in its Environment Variables page.`;
    } else if (!dotenvInstalled) {
        why = `A ".env" file exists, but the "dotenv" package is not installed, so it is not being read.\n   -> Run: npm install`;
    } else {
        why = `A ".env" file was found, but ${passEnv} is empty or missing in it.\n` +
              `   -> Make sure it has exactly one line like:  ${passEnv}=your_password  (no spaces around "=", no quotes needed)`;
    }
    return `MongoDB password is missing (${passEnv}).\n   ` + why;
}

function cleanPassword(p) {
    let v = String(p).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).trim();
    if (v.startsWith('<') && v.endsWith('>')) v = v.slice(1, -1);
    return v;
}

function buildMongoUri(serverId = 1) {
    const def = SERVER_DEFS[serverId];
    if (!def) throw new Error('Unknown server ' + serverId);
    let uri = (process.env[def.uriEnv] || def.defaultUri).trim();
    if (uri.includes('<db_password>')) {
        const pw = process.env[def.passEnv] ? cleanPassword(process.env[def.passEnv]) : '';
        if (!pw) throw new Error(missingPasswordMessage(def.passEnv));
        uri = uri.replace('<db_password>', () => encodeURIComponent(pw));
    }
    return uri;
}

const isAuthError = (err) => /bad auth|authentication failed/i.test(String(err?.message || err));

function hint(err) {
    const m = String(err?.message || err);
    if (isAuthError(err))
        return 'Wrong database username or password. Check MONGODB_PASSWORD (Atlas → Database Access → Edit user → set a new password).';
    if (/querySrv|_mongodb\._tcp|ENOTFOUND/i.test(m))
        return 'DNS lookup of the cluster failed. Check the cluster address, and that this host can reach the internet. Some hosts block SRV lookups: use the non-SRV "mongodb://" string from Atlas in MONGODB_URI.';
    if (/Server selection timed out|ReplicaSetNoPrimary|ETIMEDOUT|ECONNREFUSED|whitelist|not allowed/i.test(m))
        return 'Atlas is probably blocking this server. In Atlas → Network Access → Add IP Address → "Allow access from anywhere" (0.0.0.0/0).';
    return '';
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const OPTS = {
    dbName: DB_NAME,
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000,
    heartbeatFrequencyMS: 10000,
    maxIdleTimeMS: 60000
};

function watch(conn, label) {
    conn.on('error', (err) => console.error(`❌ MongoDB error (${label}):`, err?.message || err));
    conn.on('disconnected', () => console.warn(`⚠️ MongoDB ${label} disconnected (will auto-reconnect)`));
    conn.on('reconnected', () => console.log(`✅ MongoDB ${label} reconnected`));
}

async function connectMongo(serverId = 1, { retries = 5, delayMs = 5000 } = {}) {
    const uri = buildMongoUri(serverId);
    const label = 'Server ' + serverId;

    for (let attempt = 1; attempt <= retries; attempt++) {
        let conn = null;
        try {
            if (serverId === 1) {
                await mongoose.connect(uri, OPTS);
                conn = mongoose.connection;
            } else {
                conn = mongoose.createConnection(uri, OPTS);
                watch(conn, label);
                await conn.asPromise();
            }
            await conn.db.admin().ping();
            conns[serverId] = conn;
            console.log(`𝐌ᴏɴɢᴏ𝐃𝐁 𝐂ᴏɴɴᴇᴄᴛᴇᴅ ✅  (${label})`);
            return true;
        } catch (err) {
            console.error(`❌ MongoDB ${label} connection failed (attempt ${attempt}/${retries}):`, err?.message || err);
            if (serverId !== 1 && conn) { try { await conn.close(); } catch (e) {} }
            const h = hint(err);
            if (h) console.error('👉', h);
            if (isAuthError(err)) return false;
            if (attempt < retries) await sleep(delayMs);
        }
    }
    return false;
}

const getConn = (serverId = 1) => conns[serverId] || null;
const isConnected = (serverId = 1) => !!conns[serverId] && conns[serverId].readyState === 1;

function getModel(serverId, name, schema, collection) {
    const conn = conns[serverId];
    if (!conn) throw new Error(`Server ${serverId} is not connected`);
    return conn.models[name] || conn.model(name, schema, collection);
}

async function waitForConnection(timeoutMs = 30000, serverId = 1) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (isConnected(serverId)) return true;
        await sleep(500);
    }
    return isConnected(serverId);
}

watch(mongoose.connection, 'Server 1');

module.exports = { connectMongo, isConnected, waitForConnection, buildMongoUri, hint, getConn, getModel, serverIds };
