//Xeno Exe
// Tiny schema-less protobuf dumper. Prints every field in a raw protobuf buffer, including
// fields the Baileys schema does not know about. Used by DEBUG_REACTIONS in pair.js to see
// what a WhatsApp "sticker reaction" really looks like on the wire.

function readVarint(buf, pos) {
    let result = 0n, shift = 0n
    while (pos < buf.length) {
        const b = buf[pos++]
        result |= BigInt(b & 0x7f) << shift
        if (!(b & 0x80)) return { value: result, pos }
        shift += 7n
        if (shift > 70n) break
    }
    return null
}

// Parse buf as a protobuf message. Returns an array of fields, or null if it is not valid.
function parse(buf) {
    const fields = []
    let pos = 0
    while (pos < buf.length) {
        const key = readVarint(buf, pos)
        if (!key) return null
        pos = key.pos
        const field = Number(key.value >> 3n), wire = Number(key.value & 7n)
        if (field < 1 || field > 4000) return null
        if (wire === 0) {
            const v = readVarint(buf, pos); if (!v) return null
            pos = v.pos; fields.push({ field, wire, value: v.value })
        } else if (wire === 1) {
            if (pos + 8 > buf.length) return null
            fields.push({ field, wire, value: buf.subarray(pos, pos + 8) }); pos += 8
        } else if (wire === 5) {
            if (pos + 4 > buf.length) return null
            fields.push({ field, wire, value: buf.subarray(pos, pos + 4) }); pos += 4
        } else if (wire === 2) {
            const l = readVarint(buf, pos); if (!l) return null
            const len = Number(l.value); pos = l.pos
            if (len < 0 || pos + len > buf.length) return null
            fields.push({ field, wire, value: buf.subarray(pos, pos + len) }); pos += len
        } else return null
    }
    return fields
}

const printable = (b) => {
    if (!b.length) return false
    const s = b.toString('utf8')
    return !s.includes('\ufffd') && /^[\x09\x0a\x0d\x20-\x7e\u00a0-\u{10ffff}]*$/u.test(s)
}

function dump(buf, indent = 0, maxHex = 48) {
    const pad = '  '.repeat(indent)
    const fields = parse(buf)
    if (!fields) return pad + '(not a protobuf) ' + buf.subarray(0, maxHex).toString('hex') + '\n'
    let out = ''
    for (const f of fields) {
        if (f.wire === 0) out += `${pad}${f.field}: ${f.value}\n`
        else if (f.wire === 1 || f.wire === 5) out += `${pad}${f.field}: fixed ${Buffer.from(f.value).toString('hex')}\n`
        else {
            const v = Buffer.from(f.value)
            const nested = v.length ? parse(v) : null
            if (nested && nested.length && indent < 8) {
                out += `${pad}${f.field}: {  // ${v.length} bytes\n${dump(v, indent + 1, maxHex)}${pad}}\n`
            } else if (printable(v)) {
                out += `${pad}${f.field}: ${JSON.stringify(v.toString('utf8').slice(0, 200))}\n`
            } else {
                out += `${pad}${f.field}: bytes(${v.length}) ${v.subarray(0, maxHex).toString('hex')}${v.length > maxHex ? '...' : ''}\n`
            }
        }
    }
    return out
}

module.exports = { dump }
