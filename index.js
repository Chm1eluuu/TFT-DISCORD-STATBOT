require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, Routes, EmbedBuilder, REST } = require('discord.js');
const axios = require('axios');
const fs = require('fs');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages
    ] 
});

const DATA_FILE = './database.json';
const RIOT_KEY = process.env.RIOT_API_KEY;

// Pomocnicze do regionów: EUNE to platforma 'eun1', ale region to 'europe'
const PLATFORM = process.env.PLATFORM || 'eun1';
const REGION = process.env.REGION || 'europe';

let db = { players: [], lastTopMessageId: null };
if (fs.existsSync(DATA_FILE)) {
    try {
        db = JSON.parse(fs.readFileSync(DATA_FILE));
    } catch (e) { console.error("Błąd bazy danych, resetuję..."); }
}

const saveDB = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

// --- KOMENDY ---
const commands = [
    new SlashCommandBuilder()
        .setName('track')
        .setDescription('Śledź gracza (Riot API)')
        .addStringOption(opt => opt.setName('nick').setDescription('Nick#Tag').setRequired(true)),
    new SlashCommandBuilder()
        .setName('untrack')
        .setDescription('Usuń gracza')
        .addStringOption(opt => opt.setName('nick').setDescription('Nick#Tag').setRequired(true))
].map(c => c.toJSON());

// --- FUNKCJE RIOT API ---

async function getPuuid(name, tag) {
    try {
        const url = `https://${REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?api_key=${RIOT_KEY}`;
        const res = await axios.get(url);
        return res.data.puuid;
    } catch (e) { return null; }
}

async function getRankData(puuid) {
    try {
        const url = `https://${PLATFORM}.api.riotgames.com/tft/league/v1/entries/by-summoner/${puuid}?api_key=${RIOT_KEY}`;
        // Uwaga: Riot wymaga SummonerId do rankingu, ale w nowym API używamy PUUID. 
        // W razie błędu 404, najpierw pobierz summonerId przez /tft/summoner/v1/summoners/by-puuid/
        const summUrl = `https://${PLATFORM}.api.riotgames.com/tft/summoner/v1/summoners/by-puuid/${puuid}?api_key=${RIOT_KEY}`;
        const summRes = await axios.get(summUrl);
        const rankRes = await axios.get(`https://${PLATFORM}.api.riotgames.com/tft/league/v1/entries/by-summoner/${summRes.data.id}?api_key=${RIOT_KEY}`);
        
        return rankRes.data.find(e => e.queueType === 'RANKED_TFT') || { tier: 'UNRANKED', rank: '', leaguePoints: 0 };
    } catch (e) { return null; }
}

async function checkLiveGame(puuid) {
    try {
        const url = `https://${PLATFORM}.api.riotgames.com/tft/spectator/v1/active-games/by-puuid/${puuid}?api_key=${RIOT_KEY}`;
        const res = await axios.get(url);
        return res.data ? true : false;
    } catch (e) { return false; }
}

async function getLastMatch(puuid) {
    try {
        const listUrl = `https://${REGION}.api.riotgames.com/tft/match/v1/matches/by-puuid/${puuid}/ids?count=1&api_key=${RIOT_KEY}`;
        const listRes = await axios.get(listUrl);
        if (!listRes.data.length) return null;

        const matchId = listRes.data[0];
        const detailUrl = `https://${REGION}.api.riotgames.com/tft/match/v1/matches/${matchId}?api_key=${RIOT_KEY}`;
        const detailRes = await axios.get(detailUrl);
        
        const participant = detailRes.data.info.participants.find(p => p.puuid === puuid);
        return {
            id: matchId,
            placement: participant.placement,
            goldLeft: participant.gold_left,
            lastRound: participant.last_round,
            time: detailRes.data.info.game_datetime
        };
    } catch (e) { return null; }
}

// --- LOGIKA MONITORA ---

async function monitor() {
    const alertChannel = await client.channels.fetch(process.env.TARGET_CHANNEL_ID).catch(() => null);
    
    for (let player of db.players) {
        // 1. Sprawdzanie Live Game
        const isCurrentlyPlaying = await checkLiveGame(player.puuid);
        if (isCurrentlyPlaying && !player.inGame) {
            player.inGame = true;
            saveDB();
            if (alertChannel) {
                const emb = new EmbedBuilder()
                    .setTitle(`🚀 [LIVE] ${player.name} rozpoczął grę!`)
                    .setColor(0x5865F2)
                    .setTimestamp();
                alertChannel.send({ embeds: [emb] });
            }
        } else if (!isCurrentlyPlaying && player.inGame) {
            player.inGame = false;
            saveDB();
        }

        // 2. Sprawdzanie Wyniku
        const match = await getLastMatch(player.puuid);
        if (match && player.lastMatchId !== match.id) {
            const isFirst = player.lastMatchId === null;
            player.lastMatchId = match.id;
            
            const rank = await getRankData(player.puuid);
            player.rank = `${rank.tier} ${rank.rank}`;
            player.lp = rank.leaguePoints;
            saveDB();

            if (!isFirst && alertChannel) {
                const color = match.placement <= 4 ? 0x2ECC71 : 0xE74C3C;
                const emb = new EmbedBuilder()
                    .setTitle(`🏁 Wynik: ${player.name}`)
                    .setColor(color)
                    .addFields(
                        { name: 'Miejsce', value: `#${match.placement}`, inline: true },
                        { name: 'Ranga', value: `${player.rank} (${player.lp} LP)`, inline: true }
                    )
                    .setFooter({ text: `Mecz: ${match.id}` })
                    .setTimestamp();
                alertChannel.send({ embeds: [emb] });
            }
        }
    }
    await updateTop();
}

async function updateTop() {
    const channel = await client.channels.fetch(process.env.TOP_CHANNEL_ID).catch(() => null);
    if (!channel) return;

    const emb = new EmbedBuilder()
        .setTitle('🏆 TFT LEADERBOARD (RIOT API)')
        .setColor(0xF1C40F)
        .setTimestamp();

    let desc = "";
    for (let player of db.players) {
        const status = player.inGame ? "🔴 **W GRZE**" : "💤 AFK";
        desc += `**${player.name}** - ${player.rank || 'Dębowy IV'} (${player.lp || 0} LP)\nStatus: ${status}\n\n`;
    }
    emb.setDescription(desc || "Użyj /track");

    if (db.lastTopMessageId) {
        const msg = await channel.messages.fetch(db.lastTopMessageId).catch(() => null);
        if (msg) return msg.edit({ embeds: [emb] });
    }
    const newMsg = await channel.send({ embeds: [emb] });
    db.lastTopMessageId = newMsg.id;
    saveDB();
}

// --- START ---

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply();

    if (interaction.commandName === 'track') {
        const input = interaction.options.getString('nick');
        const [n, t] = input.split('#');
        const puuid = await getPuuid(n, t);

        if (!puuid) return interaction.editReply("❌ Nie znaleziono gracza o takim ID.");

        db.players.push({ name: input, puuid, lastMatchId: null, inGame: false, rank: '', lp: 0 });
        saveDB();
        await interaction.editReply(`✅ Teraz śledzę **${input}** przez Riot API.`);
    }
});

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ BOT RIOT API GOTOWY");
    setInterval(monitor, 60000);
});

client.login(process.env.DISCORD_TOKEN);