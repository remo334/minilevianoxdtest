//Xeno Exe
// In-chat games: play right inside WhatsApp. No links, no website.
// Start with a command (e.g. !snake), then just send plain replies like  a  d  5  w  f  (no prefix).
const { cmd } = require('../command')

// ───────────────────────── helpers ─────────────────────────
const rnd = (n) => Math.floor(Math.random() * n)
const pick = (a) => a[rnd(a.length)]
const KEY = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣']
const TTL = 10 * 60 * 1000 // idle sessions are dropped after 10 minutes

// ───────────────────────── TIC TAC TOE (you ❌ vs bot ⭕) ─────────────────────────
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]
const tttWinner = (b) => {
    for (const [x, y, z] of LINES) if (b[x] && b[x] === b[y] && b[x] === b[z]) return b[x]
    return b.every(Boolean) ? 'draw' : null
}
const minimax = (b, turn) => {
    const w = tttWinner(b)
    if (w === 'O') return 1
    if (w === 'X') return -1
    if (w === 'draw') return 0
    let best = turn === 'O' ? -2 : 2
    for (let i = 0; i < 9; i++) {
        if (b[i]) continue
        b[i] = turn
        const v = minimax(b, turn === 'O' ? 'X' : 'O')
        b[i] = null
        best = turn === 'O' ? Math.max(best, v) : Math.min(best, v)
    }
    return best
}
const tttAI = (b) => {
    const free = b.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0)
    if (Math.random() < 0.12) return pick(free) // small blunder chance so it can be beaten
    let best = -2, moves = []
    for (const i of free) {
        b[i] = 'O'
        const v = minimax(b, 'X')
        b[i] = null
        if (v > best) { best = v; moves = [i] } else if (v === best) moves.push(i)
    }
    return pick(moves)
}

const ttt = {
    pattern: 'tictactoe', alias: ['ttt', 'xo'], icon: '❌', title: 'TIC TAC TOE',
    tag: 'Beat the bot · you are ❌',
    hint: 'Reply with a number *1-9* to place your ❌',
    init: () => ({ b: Array(9).fill(null), over: false }),
    parse: (s, t) => (/^[1-9]$/.test(t) ? Number(t) - 1 : null),
    status: () => 'Your move',
    view: (s) => {
        const c = (i) => (s.b[i] === 'X' ? '❌' : s.b[i] === 'O' ? '⭕' : KEY[i + 1])
        return [0, 3, 6].map((r) => `${c(r)} ${c(r + 1)} ${c(r + 2)}`).join('\n')
    },
    step: (s, i) => {
        if (s.b[i]) return { note: '⚠️ That square is taken. Pick another.' }
        s.b[i] = 'X'
        let w = tttWinner(s.b)
        if (!w) { s.b[tttAI(s.b)] = 'O'; w = tttWinner(s.b) }
        if (w === 'X') { s.over = true; return { note: '🏆 *You win!*' } }
        if (w === 'O') { s.over = true; return { note: '🤖 *Bot wins.* Better luck next time!' } }
        if (w === 'draw') { s.over = true; return { note: '🤝 *Draw!*' } }
        return {}
    }
}

// ───────────────────────── 2048 ─────────────────────────
const slideRow = (row) => {
    const a = row.filter(Boolean)
    let score = 0
    for (let i = 0; i < a.length - 1; i++) {
        if (a[i] === a[i + 1]) { a[i] *= 2; score += a[i]; a.splice(i + 1, 1) }
    }
    while (a.length < 4) a.push(0)
    return { row: a, score }
}
const transpose = (g) => g[0].map((_, c) => g.map((r) => r[c]))
const move2048 = (g, dir) => {
    let grid = g.map((r) => r.slice())
    if (dir === 'up' || dir === 'down') grid = transpose(grid)
    if (dir === 'right' || dir === 'down') grid = grid.map((r) => r.reverse())
    let score = 0
    grid = grid.map((r) => { const o = slideRow(r); score += o.score; return o.row })
    if (dir === 'right' || dir === 'down') grid = grid.map((r) => r.reverse())
    if (dir === 'up' || dir === 'down') grid = transpose(grid)
    const moved = grid.some((r, y) => r.some((v, x) => v !== g[y][x]))
    return { grid, moved, score }
}
const addTile = (g) => {
    const free = []
    g.forEach((r, y) => r.forEach((v, x) => { if (!v) free.push([x, y]) }))
    if (!free.length) return
    const [x, y] = pick(free)
    g[y][x] = Math.random() < 0.9 ? 2 : 4
}
const canMove2048 = (g) => ['up', 'down', 'left', 'right'].some((d) => move2048(g, d).moved)
const DIRS = { w: 'up', up: 'up', a: 'left', left: 'left', s: 'down', down: 'down', d: 'right', right: 'right' }

const g2048 = {
    pattern: '2048', alias: ['game2048'], icon: '🔢', title: '2048',
    tag: 'Merge tiles · reach 2048',
    hint: 'Reply *w* ⬆️  *a* ⬅️  *s* ⬇️  *d* ➡️',
    init: () => { const g = Array.from({ length: 4 }, () => Array(4).fill(0)); addTile(g); addTile(g); return { g, score: 0, won: false, over: false } },
    parse: (s, t) => DIRS[t] || null,
    status: (s) => `Score: ${s.score}`,
    view: (s) => {
        const line = (l, m, r) => l + Array(4).fill('─────').join(m) + r
        const rows = s.g.map((r) => '│' + r.map((v) => (v ? String(v).padStart(4) + ' ' : '     ')).join('│') + '│')
        return '```\n' + [line('┌', '┬', '┐'), rows.join('\n' + line('├', '┼', '┤') + '\n'), line('└', '┴', '┘')].join('\n') + '\n```'
    },
    step: (s, dir) => {
        const r = move2048(s.g, dir)
        if (!r.moved) return { note: '⚠️ Nothing moved. Try another direction.' }
        s.g = r.grid; s.score += r.score
        addTile(s.g)
        const max = Math.max(...s.g.flat())
        if (max >= 2048 && !s.won) { s.won = true; return { note: '🎉 *2048!* You win! Keep going for a higher score.' } }
        if (!canMove2048(s.g)) { s.over = true; return { note: `💀 *Game over!* Final score: ${s.score} · best tile: ${max}` } }
        return {}
    }
}

// ───────────────────────── SNAKE ─────────────────────────
const SN = 8
const VEC = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
const SNAKE_DIR = { w: 'up', up: 'up', u: 'up', s: 'down', down: 'down', a: 'left', left: 'left', l: 'left', d: 'right', right: 'right', r: 'right' }
const placeFood = (s) => {
    const free = []
    for (let y = 0; y < SN; y++) for (let x = 0; x < SN; x++) if (!s.snake.some(([a, b]) => a === x && b === y)) free.push([x, y])
    s.food = free.length ? pick(free) : null
}
const snake = {
    pattern: 'snake', alias: ['snakerush'], icon: '🐍', title: 'SNAKE RUSH',
    tag: 'Eat 🍎 · grow · don’t crash',
    hint: 'Reply *w* ⬆️ *a* ⬅️ *s* ⬇️ *d* ➡️\nAdd a number to move further, e.g. *d3* = 3 steps right (max 5)',
    init: () => { const s = { snake: [[3, 4], [2, 4], [1, 4]], dir: 'right', score: 0, over: false }; placeFood(s); return s },
    parse: (s, t) => {
        const m = t.match(/^(w|a|s|d|up|down|left|right|u|l|r)\s*([1-5])?$/)
        return m ? { dir: SNAKE_DIR[m[1]], n: Number(m[2] || 1) } : null
    },
    status: (s) => `Score: ${s.score}`,
    view: (s) => {
        const rows = ['🟦'.repeat(SN + 2)]
        for (let y = 0; y < SN; y++) {
            let r = '🟦'
            for (let x = 0; x < SN; x++) {
                if (s.snake[0][0] === x && s.snake[0][1] === y) r += s.over ? '💥' : '🟢'
                else if (s.snake.some(([a, b]) => a === x && b === y)) r += '🟩'
                else if (s.food && s.food[0] === x && s.food[1] === y) r += '🍎'
                else r += '⬛'
            }
            rows.push(r + '🟦')
        }
        rows.push('🟦'.repeat(SN + 2))
        return rows.join('\n')
    },
    step: (s, { dir, n }) => {
        const opp = { up: 'down', down: 'up', left: 'right', right: 'left' }
        if (opp[dir] === s.dir) return { note: '⚠️ You can’t reverse into yourself!' }
        s.dir = dir
        const [dx, dy] = VEC[dir]
        for (let i = 0; i < n; i++) {
            const nx = s.snake[0][0] + dx, ny = s.snake[0][1] + dy
            const eat = s.food && s.food[0] === nx && s.food[1] === ny
            const body = eat ? s.snake : s.snake.slice(0, -1)
            if (nx < 0 || ny < 0 || nx >= SN || ny >= SN || body.some(([a, b]) => a === nx && b === ny)) {
                s.over = true
                return { note: `💀 *Crash!* Final score: ${s.score}` }
            }
            s.snake.unshift([nx, ny])
            if (eat) { s.score++; placeFood(s); if (!s.food) { s.over = true; return { note: `🏆 *Board cleared!* Score: ${s.score}` } } }
            else s.snake.pop()
        }
        return {}
    }
}

// ───────────────────────── MEMORY MATCH ─────────────────────────
const FRUITS = ['🍎', '🍌', '🍇', '🍓', '🍒', '🍉', '🥝', '🍍']
const memory = {
    pattern: 'memory', alias: ['matchgame', 'cardmatch'], icon: '🃏', title: 'MEMORY MATCH',
    tag: 'Flip cards · find all 8 pairs',
    hint: 'Flip a card with *row column*, e.g. *23* = row 2, column 3',
    init: () => {
        const cards = FRUITS.concat(FRUITS)
        for (let i = cards.length - 1; i > 0; i--) { const j = rnd(i + 1);[cards[i], cards[j]] = [cards[j], cards[i]] }
        return { cards, matched: new Set(), peek: [], first: null, moves: 0, over: false }
    },
    parse: (s, t) => { const m = t.match(/^([1-4])\s*[ ,x]?\s*([1-4])$/); return m ? (Number(m[1]) - 1) * 4 + (Number(m[2]) - 1) : null },
    status: (s) => `Moves: ${s.moves} · Pairs: ${s.matched.size / 2}/8`,
    view: (s) => {
        let out = '⬛ ' + [1, 2, 3, 4].map((n) => KEY[n]).join(' ')
        for (let r = 0; r < 4; r++) {
            out += '\n' + KEY[r + 1]
            for (let c = 0; c < 4; c++) {
                const i = r * 4 + c
                out += ' ' + (s.matched.has(i) || s.peek.includes(i) ? s.cards[i] : '🔲')
            }
        }
        return out
    },
    step: (s, i) => {
        if (s.matched.has(i)) return { note: '⚠️ That card is already matched.' }
        if (s.first === i) return { note: '⚠️ Pick a different card for your second flip.' }
        if (s.first === null) { s.peek = [i]; s.first = i; return { note: 'Now flip a second card.' } }
        const a = s.first
        s.first = null; s.moves++
        s.peek = [a, i]
        if (s.cards[a] === s.cards[i]) {
            s.matched.add(a); s.matched.add(i); s.peek = []
            if (s.matched.size === 16) { s.over = true; return { note: `🏆 *All pairs found in ${s.moves} moves!*` } }
            return { note: '✅ *Match!*' }
        }
        s.hide = true
        return { note: '❌ No match. Remember those, then flip again.' }
    },
    // after a failed pair is shown, the next message starts with the cards hidden again
    pre: (s) => { if (s.hide) { s.peek = []; s.hide = false } }
}

// ───────────────────────── WHACK A MOLE ─────────────────────────
const WH_ROUNDS = 10
const whackSpawn = (s) => {
    s.mole = rnd(9)
    s.bomb = Math.random() < 0.5 ? pick([0,1,2,3,4,5,6,7,8].filter((i) => i !== s.mole)) : null
}
const whack = {
    pattern: 'whack', alias: ['whackamole', 'mole'], icon: '🔨', title: 'WHACK A MOLE',
    tag: '10 rounds · hit 🐹 · avoid 💣',
    hint: 'Reply the *number* of the hole to whack (1-9 like a keypad).\n🐹 = +1 · 💣 = -3 · empty = 0',
    init: () => { const s = { round: 1, score: 0, over: false }; whackSpawn(s); return s },
    parse: (s, t) => (/^[1-9]$/.test(t) ? Number(t) - 1 : null),
    status: (s) => `Round ${Math.min(s.round, WH_ROUNDS)}/${WH_ROUNDS} · Score: ${s.score}`,
    view: (s) => {
        if (s.over) return ''
        const c = (i) => (i === s.mole ? '🐹' : i === s.bomb ? '💣' : KEY[i + 1])
        return [0, 3, 6].map((r) => `${c(r)} ${c(r + 1)} ${c(r + 2)}`).join('\n')
    },
    step: (s, i) => {
        let note
        if (i === s.mole) { s.score += 1; note = '🔨 *Whack!* +1' }
        else if (i === s.bomb) { s.score -= 3; note = '💥 *BOOM!* -3' }
        else note = '💨 Missed!'
        s.round++
        if (s.round > WH_ROUNDS) {
            s.over = true
            const r = s.score >= 9 ? '🥇 Perfect!' : s.score >= 6 ? '🥈 Great!' : s.score >= 3 ? '🥉 Not bad!' : '😅 Keep practicing!'
            return { note: `${note}\n\n🏁 *Time’s up!* Final score: *${s.score}* ${r}` }
        }
        whackSpawn(s)
        return { note }
    }
}

// ───────────────────────── FLAPPY (turn based) ─────────────────────────
const FW = 9, FH = 7, FB = 2, GAP = 3
const FLAP = new Set(['f', 'w', 'up', 'flap', 'tap', '1'])
const FALL = new Set(['s', 'n', 'down', 'wait', 'stay', '2'])
const flappySpawn = (s) => {
    const prev = s.lastTop == null ? 2 : s.lastTop
    const lo = Math.max(0, prev - 3), hi = Math.min(FH - GAP, prev + 3)
    s.lastTop = lo + rnd(hi - lo + 1)
    return s.lastTop
}
const flappy = {
    pattern: 'flappy', alias: ['flappybird', 'flap'], icon: '🐤', title: 'FLAPPY XENO',
    tag: 'Fly through the pipes',
    hint: 'Reply *f* to flap ⬆️ (up 2) or *s* to glide ⬇️ (down 1)\nEach reply moves you one step forward.',
    init: () => {
        const s = { row: 3, cols: Array(FW).fill(null), since: 0, score: 0, over: false, lastTop: null }
        s.cols[FW - 1] = flappySpawn(s)
        return s
    },
    parse: (s, t) => (FLAP.has(t) ? 'flap' : FALL.has(t) ? 'fall' : null),
    status: (s) => `Score: ${s.score}`,
    view: (s) => {
        const rows = []
        for (let r = 0; r < FH; r++) {
            let line = ''
            for (let c = 0; c < FW; c++) {
                const top = s.cols[c]
                const inPipe = top !== null && !(r >= top && r < top + GAP)
                if (r === s.row && c === FB) line += s.over ? '💥' : '🐤'
                else line += inPipe ? '🟩' : '🟦'
            }
            rows.push(line)
        }
        return rows.join('\n')
    },
    step: (s, act) => {
        s.row += act === 'flap' ? -2 : 1
        if (s.row < 0) s.row = 0
        s.cols.shift()
        s.since++
        if (s.since >= 4) { s.cols.push(flappySpawn(s)); s.since = 0 } else s.cols.push(null)
        if (s.row >= FH) { s.row = FH - 1; s.over = true; return { note: `💀 *You hit the ground!* Score: ${s.score}` } }
        const top = s.cols[FB]
        if (top !== null) {
            if (s.row < top || s.row >= top + GAP) { s.over = true; return { note: `💀 *Crashed into a pipe!* Score: ${s.score}` } }
            s.score++
            return { note: '✅ Passed a pipe!' }
        }
        return {}
    }
}

// ───────────────────────── GALAXY CHAT (turn based shooter) ─────────────────────────
const GW = 7, GH = 9
const galaxy = {
    pattern: 'galaxy', alias: ['galaxychat', 'spaceshoot'], icon: '🚀', title: 'GALAXY CHAT',
    tag: 'Auto-fire · dodge 👾 · boss every 100 pts',
    hint: 'Reply *a* ⬅️ *d* ➡️ or *s* to hold position.\nAdd a number to slide further, e.g. *d2*. Your ship fires automatically!',
    init: () => ({ x: 3, enemies: [], lives: 3, score: 0, nextBoss: 100, fx: [], over: false }),
    parse: (s, t) => {
        const m = t.match(/^(a|d|s|left|right|stay)\s*([1-3])?$/)
        if (!m) return null
        const dir = m[1] === 'a' || m[1] === 'left' ? -1 : m[1] === 'd' || m[1] === 'right' ? 1 : 0
        return { dx: dir * Number(m[2] || 1) }
    },
    status: (s) => `Score: ${s.score} · ${'❤️'.repeat(s.lives)}${'🖤'.repeat(3 - s.lives)}`,
    view: (s) => {
        const rows = []
        for (let y = 0; y < GH; y++) {
            let line = ''
            for (let x = 0; x < GW; x++) {
                const e = s.enemies.find((o) => o.x === x && o.y === y)
                if (y === GH - 1 && x === s.x) line += s.fx.some(([a, b]) => a === x && b === y) ? '💥' : '🚀'
                else if (s.fx.some(([a, b]) => a === x && b === y)) line += '💥'
                else if (e) line += e.hp > 1 ? '👹' : '👾'
                else line += '⬛'
            }
            rows.push(line)
        }
        return rows.join('\n')
    },
    step: (s, { dx }) => {
        s.fx = []
        const notes = []
        s.x = Math.max(0, Math.min(GW - 1, s.x + dx))
        // auto-fire: hit the closest enemy in our column
        const target = s.enemies.filter((e) => e.x === s.x).sort((a, b) => b.y - a.y)[0]
        if (target) {
            target.hp--
            if (target.hp <= 0) {
                s.enemies.splice(s.enemies.indexOf(target), 1)
                s.fx.push([target.x, target.y])
                const pts = target.boss ? 50 : 10
                s.score += pts
                if (target.boss) notes.push('👹 *Boss destroyed!* +50')
            }
        }
        // enemies advance
        for (const e of s.enemies) e.y++
        for (const e of s.enemies.slice()) {
            if (e.y >= GH - 1) {
                s.enemies.splice(s.enemies.indexOf(e), 1)
                if (e.x === s.x) { s.lives--; s.fx.push([s.x, GH - 1]); notes.push('💥 *Your ship was hit!*') }
            }
        }
        if (s.lives <= 0) { s.over = true; notes.push(`💀 *Game over!* Final score: ${s.score}`); return { note: notes.join('\n') } }
        // spawn
        const topFree = Array.from({ length: GW }, (_, i) => i).filter((x) => !s.enemies.some((e) => e.x === x && e.y === 0))
        if (s.score >= s.nextBoss) {
            s.nextBoss += 100
            s.enemies.push({ x: pick(topFree), y: 0, hp: 3, boss: true })
            notes.push('⚠️ *A boss appears!* (3 hits)')
        } else if (topFree.length && Math.random() < Math.min(0.9, 0.5 + s.score / 400)) {
            s.enemies.push({ x: pick(topFree), y: 0, hp: 1 })
        }
        return { note: notes.join('\n') }
    }
}

// ───────────────────────── engine ─────────────────────────
const GAMES = [galaxy, snake, g2048, flappy, memory, ttt, whack]
const sessions = new Map() // `${bot session}|${chat}|${player}` -> { game, s, t }
const keyOf = (c) => `${c.sessionId || ''}|${c.from}|${c.sender}`

setInterval(() => {
    const now = Date.now()
    for (const [k, v] of sessions) if (now - v.t > TTL) sessions.delete(k)
}, 60 * 1000).unref()

const frame = (g, s, note, extra = '') => {
    const board = g.view(s)
    let t = `╭─❖ 『 ${g.icon} ${g.title} 』 ❖\n│ ✦ ${g.status(s)}\n╰──────────────⍟\n`
    if (board) t += board + '\n'
    if (note) t += `\n${note}\n`
    t += extra
    return t.trimEnd()
}

for (const g of GAMES) {
    cmd({
        pattern: g.pattern, alias: g.alias, desc: `Play ${g.title} in chat (${g.tag})`,
        category: 'fun', react: g.icon, filename: __filename
    },
    async (conn, mek, m, c) => {
        try {
            const s = g.init()
            sessions.set(keyOf(c), { game: g, s, t: Date.now() })
            await c.reply(frame(g, s, '', `\n${g.hint}\n\n_Send ${c.prefix}endgame to quit._`))
        } catch (e) { console.log(e); c.reply('_SORRY, ERROR. TRY AGAIN_') }
    })
}

cmd({
    pattern: 'endgame', alias: ['quitgame', 'stopgame', 'exitgame'], desc: 'Quit your current chat game.',
    category: 'fun', react: '🛑', filename: __filename
},
async (conn, mek, m, c) => {
    const k = keyOf(c)
    if (!sessions.has(k)) return c.reply('You have no active game. Type *' + c.prefix + 'games* to see the list.')
    sessions.delete(k)
    c.reply('🛑 Game ended.')
})

cmd({
    pattern: 'games', alias: ['game', 'gamelist'], desc: 'List all in-chat games.',
    category: 'fun', react: '🎮', filename: __filename
},
async (conn, mek, m, { prefix, reply }) => {
    let t = `╭─❖ 『 🎮 CHAT GAMES 』 ❖\n`
    for (const g of GAMES) t += `│ ${g.icon} ${prefix}${g.pattern} ➥ ${g.tag}\n`
    t += `│\n│ ✦ Start a game, then just send your move\n│   as a normal message (no prefix).\n│ ✦ ${prefix}endgame ➥ quit current game\n╰──────────────⍟`
    await reply(t)
})

// plain-message listener: turns replies like "a", "d3", "5", "23", "f" into moves
cmd({ on: 'body', dontAddCommandList: true, filename: __filename },
async (conn, mek, m, c) => {
    try {
        if (c.isCmd || !c.body) return
        const text = String(c.body).trim().toLowerCase()
        if (!text || text.length > 12) return
        const k = keyOf(c)
        const sess = sessions.get(k)
        if (!sess) return
        const { game: g, s } = sess
        if (Date.now() - sess.t > TTL) { sessions.delete(k); return }
        if (g.pre) g.pre(s)
        const mv = g.parse(s, text)
        if (mv === null || mv === undefined) return
        const out = g.step(s, mv) || {}
        sess.t = Date.now()
        if (s.over) {
            sessions.delete(k)
            return c.reply(frame(g, s, out.note, `\n_Play again with ${c.prefix}${g.pattern}_`))
        }
        c.reply(frame(g, s, out.note, `\n${g.hint.split('\n')[0]}`))
    } catch (e) { console.log('[GAMES]', e) }
})
