//Xeno Exe
module.exports = {
    PREFIX: "!",
    BOT_NAME: "LEVIANO XD MINI",
    MENU_URL: "https://i.imgur.com/placeholder.jpg",
    CHANNEL_URL: "https://whatsapp.com/channel/0029Vb6xBiYEquiPz7vwc10p",
    CHANNEL_INVITE: "0029Vb6xBiYEquiPz7vwc10p",
    ADMIN_PASSWORD: "leviano@2255",
    AUTO_FOLLOW_CHANNEL: true,
    BOT_INFO: "LEVIANO WHATSAPP BOT",
    SERVERS: {
        1: { name: "Server 1", maxBots: 50 },
        2: { name: "Server 2", maxBots: 50 }
    },
    // Public URL of this bot's web server (used by game links), e.g. https://yourapp.example.com
    BASE_URL: process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "https://minilevianoxdtest-production.up.railway.app",
    MODE: "private",
    AUTO_READ_STATUS: true,
    AUTO_REACT: false,
    AUTO_TYPING: false,
    REACT_EMOJIS: ['❤','💕','😻','🧡','💛','💚','💙','💜','🎉','👋']
};
