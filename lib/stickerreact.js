//Xeno Exe
// The ONE place that knows how to put a sticker on a message as a reaction.
//
// WhatsApp's sticker reactions are newer than the Baileys version this bot runs
// (@whiskeysockets/baileys 6.7.24), and the wire format is not documented anywhere
// public. So this file does not guess it. It uses `conn.sendStickerReaction` if your
// Baileys build / fork provides one, otherwise it throws STICKER_REACTION_UNSUPPORTED
// and the plugin falls back to sending the sticker as a reply to that message.
//
// Once the format is known (capture it with DEBUG_REACTIONS=1, see pair.js), implement
// it here and nothing else needs to change.
//
//   conn    - the Baileys socket
//   from    - chat jid
//   key     - key of the message being reacted to
//   sticker - Buffer (.webp)
module.exports = async function sendStickerReaction(conn, from, key, sticker) {
    if (typeof conn.sendStickerReaction === 'function') {
        return conn.sendStickerReaction(from, key, sticker)
    }
    const e = new Error('STICKER_REACTION_UNSUPPORTED')
    e.code = 'STICKER_REACTION_UNSUPPORTED'
    throw e
}
