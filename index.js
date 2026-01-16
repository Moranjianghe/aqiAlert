require('dotenv').config();
const axios = require('axios');
const express = require('express');
const { Feed } = require('feed');
const { Telegraf } = require('telegraf');
const cron = require('node-cron');

// --- 配置區 ---
const CONFIG = {
    AQI_TOKEN: process.env.AQI_TOKEN, // 你的 AQI API Token
    STATION_ID: process.env.STATION_ID, // 監測站 ID
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    PORT: process.env.PORT,
    CHECK_INTERVAL: '*/30 * * * *' // 每 30 分鐘執行
};

const app = express();
const bot = new Telegraf(CONFIG.TG_TOKEN);

// 全局變量，存放生成的 RSS 文本
let currentRssXml = '';

// AQI 等級對應表
const getAqiLevel = (aqi) => {
    if (aqi <= 50) return { label: '優', color: '綠' };
    if (aqi <= 100) return { label: '良', color: '黃' };
    if (aqi <= 150) return { label: '輕度污染', color: '橘' };
    if (aqi <= 200) return { label: '中度污染', color: '紅/橙' }; // 對應你說的橙色
    return { label: '重度污染', color: '紫' };
};

// 核心任務：獲取數據並處理邏輯
async function updateAqiTask() {
    try {
        const url = `https://api.waqi.info/feed/${CONFIG.STATION_ID}/?token=${CONFIG.AQI_TOKEN}`;
        const res = await axios.get(url);
        if (res.data.status !== 'ok') return;

        const aqi = res.data.data.aqi;
        const time = res.data.data.time.s;
        const level = getAqiLevel(aqi);

        console.log(`[${new Date().toLocaleString()}] 當前 AQI: ${aqi} (${level.label})`);

        // 1. 邏輯判斷：高於橘色 (AQI > 100) 時，更新 RSS
        if (aqi > 100) {
            try {
                const feed = new Feed({
                    title: "AQI 預警",
                    description: "高於橘色級別的空氣監測",
                    id: "http://localhost/",
                    link: "http://localhost/",
                    updated: new Date(),
                });

                feed.addItem({
                    title: `⚠️ AQI 警告: ${aqi} - ${level.label}`,
                    description: `更新時間: ${time}，請注意健康防護。`,
                    date: new Date(),
                });
                currentRssXml = feed.rss2();
            } catch (rssError) {
                console.error('RSS 更新失敗:', rssError.message);
            }
        }

        // 2. 邏輯判斷：高於橙色/紅色 (AQI > 150) 時，電報報警
        if (aqi > 150) {
            if (CONFIG.TG_TOKEN && CONFIG.TG_TOKEN !== 'xxx') {
                bot.telegram.sendMessage(CONFIG.TG_CHAT_ID, message).catch(tgError => {
                    console.error('Telegram 發送失敗 (已跳過):', tgError.message);
                });
            } else {
                console.log('Telegram Token 未配置或為預設值，跳過通知');
            }
        }

    } catch (error) {
        console.error('抓取失敗:', error.message);
    }
}

// 設置定時任務
cron.schedule(CONFIG.CHECK_INTERVAL, updateAqiTask);

// RSS Web 接口
app.get('/aqi.xml', (req, res) => {
    res.set('Content-Type', 'text/xml');
    res.send(currentRssXml || '<rss><channel><title>暫無數據</title></channel></rss>');
});

// 啟動服務
app.listen(CONFIG.PORT, '127.0.0.1', () => {
    console.log(`服務已啟動: http://127.0.0.1:${CONFIG.PORT}/aqi.xml`);
    updateAqiTask(); // 啟動時先執行一次
});