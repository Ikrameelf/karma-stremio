// sources/nowtv.js

const axios = require("axios");

const BASE_URL = "https://www.nowtv.com.tr";

const headers = {
    "User-Agent":
        "Mozilla/5.0 (Linux; Android 10; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept-Language": "tr-TR,tr;q=0.9",
    "Referer": `${BASE_URL}/`
};

async function getPage(url) {
    try {
        const response = await axios.get(url, {
            headers,
            timeout: 15000
        });

        return response.data;
    } catch (error) {
        console.error("[NOW TV] Page error:", error.message);
        return null;
    }
}

function absoluteUrl(url) {
    if (!url) return null;

    if (url.startsWith("http://") || url.startsWith("https://")) {
        return url;
    }

    return new URL(url, BASE_URL).href;
}

/*
 * Cherche les URLs NOW correspondant aux pages d'épisodes.
 *
 * Exemple :
 * https://www.nowtv.com.tr/Nom-Dizi/bolum/123
 */
function extractEpisodeUrls(html) {
    if (!html) return [];

    const results = new Set();

    const regex =
        /(?:href|content)=["']([^"']*\/bolum\/[^"']+)["']/gi;

    let match;

    while ((match = regex.exec(html)) !== null) {
        const url = absoluteUrl(match[1]);

        if (url && url.includes("/bolum/")) {
            results.add(url);
        }
    }

    return [...results];
}

/*
 * Pour l'instant on recherche les différentes formes
 * que NOW peut utiliser pour transmettre la vidéo
 * au lecteur.
 */
function extractVideoData(html) {
    if (!html) return [];

    const results = new Set();

    const patterns = [
        /https?:\/\/[^"'\\\s]+\.m3u8[^"'\\\s]*/gi,
        /https?:\/\/[^"'\\\s]+\.mp4[^"'\\\s]*/gi,
        /https?:\/\/[^"'\\\s]+\/video\/[^"'\\\s]*/gi
    ];

    for (const regex of patterns) {
        let match;

        while ((match = regex.exec(html)) !== null) {
            results.add(match[0]);
        }
    }

    return [...results];
}

async function getEpisodes(seriesUrl) {
    const html = await getPage(seriesUrl);

    if (!html) {
        return [];
    }

    return extractEpisodeUrls(html);
}

async function getStream(episodeUrl) {
    console.log("[NOW TV] Episode:", episodeUrl);

    const html = await getPage(episodeUrl);

    if (!html) {
        return [];
    }

    const videos = extractVideoData(html);

    console.log(
        `[NOW TV] ${videos.length} flux potentiel(s) trouvé(s)`
    );

    return videos.map((url, index) => ({
        name: "NOW TV Türkiye",
        title: `NOW TV Türkiye • VO ${index + 1}`,
        url,
        type: url.includes(".m3u8") ? "hls" : "http"
    }));
}

module.exports = {
    name: "NOW TV Türkiye",
    getEpisodes,
    getStream
};
