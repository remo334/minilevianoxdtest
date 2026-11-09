//Xeno Exe
// Game plugins: each command sends a link to a mobile-friendly game page in /public/games.
// Set BASE_URL (env or config.js) to the public URL where this bot's web server is reachable.
const config = require('../config')
const { cmd, commands } = require('../command')

const GAMES = [
    { pattern: 'galaxy',  alias: ['galaxychat', 'spaceshoot'], file: 'galaxy.html',  icon: '🚀', title: 'GALAXY CHAT', tag: 'Auto-fire · boss every 500 · grab upgrades!', how: 'Drag, tap ◀ ▶ or use arrow keys. Pick up 🔥 ⚡ 🛡️ ➕ drops.' },
    { pattern: 'drumpad', alias: ['beatmaker', 'beat'],       file: 'drumpad.html', icon: '🎵', title: 'BEAT MAKER',  tag: 'Tap pads · REC 4s · it becomes a loop! 🥁',   how: 'Press REC, play for 4 seconds and it loops. Keep playing on top.' },
    { pattern: 'snake',   alias: ['snakerush'],               file: 'snake.html',   icon: '🐍', title: 'SNAKE RUSH',  tag: 'Eat, grow, speed up!',                         how: 'Swipe on the board or use the D-pad.' },
    { pattern: '2048',    alias: ['game2048'],                file: '2048.html',    icon: '🔢', title: '2048',        tag: 'Swipe to merge tiles · reach 2048!',           how: 'Swipe or use arrow keys. Equal tiles merge.' }
]

const baseUrl = () => String(config.BASE_URL || process.env.BASE_URL || '').replace(/\/+$/, '')

const card = (g, url) =>
    `╭─❖ 『 ${g.icon} ${g.title} 』 ❖\n` +
    `│ ✦ ${g.tag}\n` +
    `│ ✦ ${g.how}\n` +
    `│\n` +
    `│ ➥ ${url}\n` +
    `╰──────────────⍟\n` +
    `> Tap the link to play 🎮`

async function sendGame(conn, mek, from, reply, g) {
    const b = baseUrl()
    if (!b) return reply('*Games are not set up yet.*\nOwner: set *BASE_URL* (for example https://your-app.example.com) in the environment or config.js, then restart the bot.')
    const url = `${b}/games/${g.file}`
    await conn.sendMessage(from, {
        text: card(g, url),
        contextInfo: {
            externalAdReply: {
                title: `${g.icon} ${g.title}`,
                body: g.tag,
                mediaType: 1,
                sourceUrl: url,
                renderLargerThumbnail: false
            }
        }
    }, { quoted: mek })
}

for (const g of GAMES) {
    cmd({
        pattern: g.pattern,
        alias: g.alias,
        desc: `Play ${g.title} (${g.tag})`,
        category: 'fun',
        react: g.icon,
        filename: __filename
    },
    async (conn, mek, m, { from, reply }) => {
        try { await sendGame(conn, mek, from, reply, g) }
        catch (e) { console.log(e); reply('_SORRY, ERROR. TRY AGAIN_') }
    })
}

cmd({
    pattern: 'games',
    alias: ['game', 'gamelist'],
    desc: 'List all playable games.',
    category: 'fun',
    react: '🎮',
    filename: __filename
},
async (conn, mek, m, { from, prefix, reply }) => {
    try {
        let t = `╭─❖ 『 🎮 GAMES 』 ❖\n`
        for (const g of GAMES) t += `│ ${g.icon} ${prefix}${g.pattern} ➥ ${g.tag}\n`
        t += `╰──────────────⍟`
        await reply(t)
    } catch (e) { console.log(e); reply('_SORRY, ERROR. TRY AGAIN_') }
})
