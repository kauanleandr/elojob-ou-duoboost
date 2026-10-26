import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Configurações de Região
const REGION_ACCOUNT = "americas"; 

const SEASON_START_TIMESTAMP = Math.floor(new Date('2026-01-08T00:00:00Z').getTime() / 1000);
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.get('/api/duos-stream/:gameName/:tagLine', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (type, message, data = null) => {
        res.write(`data: ${JSON.stringify({ type, message, data })}\n\n`);
    };

    try {
        const { gameName, tagLine } = req.params;
        
        // Pega obrigatoriamente a chave enviada pela sessão do usuário (Query String ou Header)
        const RIOT_API_KEY = req.query.apiKey || req.headers['x-api-key'];

        if (!RIOT_API_KEY) {
            sendEvent('error', '❌ Nenhuma Riot API Key fornecida! Insira sua chave no site para continuar.');
            return res.end();
        }

        const cleanGameName = encodeURIComponent(gameName.trim());
        const cleanTag = encodeURIComponent(tagLine.trim());

        sendEvent('log', `🔍 Buscando jogador na Riot (BR): ${gameName}#${tagLine}...`);

        const accountUrl = `https://${REGION_ACCOUNT}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${cleanGameName}/${cleanTag}?api_key=${RIOT_API_KEY}`;
        const accountRes = await fetch(accountUrl);
        
        if (accountRes.status === 403 || accountRes.status === 401) {
            sendEvent('error', '❌ A Riot API Key informada expirou ou é inválida!');
            return res.end();
        }

        if (!accountRes.ok) {
            sendEvent('error', `❌ Jogador "${gameName}#${tagLine}" não foi encontrado.`);
            return res.end();
        }
        
        const accountData = await accountRes.json();
        const puuid = accountData.puuid;
        sendEvent('log', `✅ Jogador encontrado! PUUID: ${puuid.substring(0, 15)}...`);

        sendEvent('log', `🎮 Buscando histórico da TEMPORADA ATUAL (Ranked Solo/Duo)...`);
        
        let allMatchIds = [];
        let start = 0;
        const count = 100;
        let keepFetching = true;

        while (keepFetching) {
            const matchesUrl = `https://${REGION_ACCOUNT}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&startTime=${SEASON_START_TIMESTAMP}&start=${start}&count=${count}&api_key=${RIOT_API_KEY}`;
            const matchesRes = await fetch(matchesUrl);
            
            if (!matchesRes.ok) break;

            const pageMatchIds = await matchesRes.json();
            if (!Array.isArray(pageMatchIds) || pageMatchIds.length === 0) {
                keepFetching = false;
            } else {
                allMatchIds = allMatchIds.concat(pageMatchIds);
                start += count;
                if (pageMatchIds.length < count) keepFetching = false;
            }
        }

        sendEvent('log', `🎮 Encontradas ${allMatchIds.length} partidas ranqueadas na temporada atual.`);

        if (allMatchIds.length === 0) {
            sendEvent('done', 'Sucesso', { player: `${gameName}#${tagLine}`, soloStats: { matches: 0, wins: 0, losses: 0, winrate: "0.0" }, duoStats: { matches: 0, wins: 0, losses: 0, winrate: "0.0" }, champions: [] });
            return res.end();
        }

        const teammateOccurrences = {};
        const matchesData = [];
        const championsMap = {};

        const BATCH_SIZE = 10;
        let processedCount = 0;

        for (let i = 0; i < allMatchIds.length; i += BATCH_SIZE) {
            const batch = allMatchIds.slice(i, i + BATCH_SIZE);

            const batchPromises = batch.map(async (matchId) => {
                const matchDetailUrl = `https://${REGION_ACCOUNT}.api.riotgames.com/lol/match/v5/matches/${matchId}?api_key=${RIOT_API_KEY}`;
                try {
                    const matchRes = await fetch(matchDetailUrl);
                    if (matchRes.status === 429) {
                        await delay(1500);
                        return null;
                    }
                    if (!matchRes.ok) return null;
                    const matchData = await matchRes.json();
                    if (!matchData.info || matchData.info.queueId !== 420) return null;
                    return matchData;
                } catch {
                    return null;
                }
            });

            const results = await Promise.all(batchPromises);

            results.forEach(matchData => {
                if (!matchData) return;

                const participants = matchData.info.participants;
                const targetPlayer = participants.find(p => p.puuid === puuid);
                if (!targetPlayer) return;

                const isWin = targetPlayer.win;
                const championName = targetPlayer.championName;

                // Mapeia os campeões
                if (!championsMap[championName]) {
                    championsMap[championName] = { name: championName, matches: 0, wins: 0, losses: 0 };
                }
                championsMap[championName].matches += 1;
                if (isWin) championsMap[championName].wins += 1;
                else championsMap[championName].losses += 1;

                // Mapeia aliados
                const targetTeamId = targetPlayer.teamId;
                const teammates = participants.filter(p => p.teamId === targetTeamId && p.puuid !== puuid);
                
                const teammateKeys = teammates.map(t => `${t.riotIdGameName || t.summonerName}#${t.riotIdTagline || ''}`);

                teammateKeys.forEach(key => {
                    teammateOccurrences[key] = (teammateOccurrences[key] || 0) + 1;
                });

                matchesData.push({ isWin, teammateKeys });
            });

            processedCount += batch.length;
            sendEvent('log', `🚀 Processando partidas: ${Math.min(processedCount, allMatchIds.length)} de ${allMatchIds.length}...`);
            await delay(150);
        }

        // Define como duo apenas quem jogou 3+ partidas junto na mesma equipe
        const realDuos = new Set(Object.keys(teammateOccurrences).filter(key => teammateOccurrences[key] >= 3));

        let soloWins = 0, soloLosses = 0;
        let duoWins = 0, duoLosses = 0;

        matchesData.forEach(match => {
            const hasDuo = match.teammateKeys.some(key => realDuos.has(key));

            if (hasDuo) {
                if (match.isWin) duoWins++;
                else duoLosses++;
            } else {
                if (match.isWin) soloWins++;
                else soloLosses++;
            }
        });

        const soloMatches = soloWins + soloLosses;
        const duoMatches = duoWins + duoLosses;

        const soloWinrate = soloMatches > 0 ? ((soloWins / soloMatches) * 100).toFixed(1) : "0.0";
        const duoWinrate = duoMatches > 0 ? ((duoWins / duoMatches) * 100).toFixed(1) : "0.0";

        const topChampions = Object.values(championsMap)
            .sort((a, b) => b.matches - a.matches)
            .slice(0, 5)
            .map(c => ({
                ...c,
                winrate: ((c.wins / c.matches) * 100).toFixed(1)
            }));

        sendEvent('log', `✨ Análise concluída com sucesso! Exibindo estatísticas...`);
        
        sendEvent('done', 'Sucesso', {
            player: `${gameName}#${tagLine}`,
            soloStats: { matches: soloMatches, wins: soloWins, losses: soloLosses, winrate: soloWinrate },
            duoStats: { matches: duoMatches, wins: duoWins, losses: duoLosses, winrate: duoWinrate },
            champions: topChampions
        });

        res.end();

    } catch (err) {
        console.error(err);
        sendEvent('error', 'Erro interno no servidor.');
        res.end();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));