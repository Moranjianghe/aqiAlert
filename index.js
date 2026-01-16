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

        const data = res.data.data;
        const aqi = data.aqi;
        const time = data.time.s;
        const city = data.city.name;
        const cityUrl = data.city.url;
        const level = getAqiLevel(aqi);
        
        // 提取主要污染物細節 (如果存在)
        const pm25 = data.iaqi.pm25 ? data.iaqi.pm25.v : 'N/A';
        const pm10 = data.iaqi.pm10 ? data.iaqi.pm10.v : 'N/A';

        console.log(`[${new Date().toLocaleString()}] 當前位置: ${city}, AQI: ${aqi} (${level.label})`);

        // 1. 邏輯判斷：高於橘色 (AQI > 100) 時，更新 RSS
        if (aqi > 100) {
            try {
                const feed = new Feed({
                    title: `AQI 預警 - ${city}`,
                    description: `來自 ${city} 的即時空氣量監測`,
                    id: cityUrl,
                    link: cityUrl,
                    updated: new Date(),
                });

                feed.addItem({
                    title: `⚠️ [${level.label}] AQI 數值達 ${aqi} (${city})`,
                    description: `監測站位置: ${city}
當前 AQI: ${aqi}
健康等級: ${level.label}
主要數據: PM2.5: ${pm25}, PM10: ${pm10}
更新時間: ${time}
請盡量減少戶外活動並佩戴口罩。`,
                    link: cityUrl,
                    date: new Date(),
                });
                currentRssXml = feed.rss2();
            } catch (rssError) {
                console.error('RSS 更新失敗:', rssError.message);
            }
        }

        // 2. 邏輯判斷：高於橙色/紅色 (AQI > 150) 時，電報報警
        if (aqi > 150) {
            const message = `🚨🚨🚨 【緊急空氣預警】\n\n` +
                          `📍 監測地點：${city}\n` +
                          `🤒 空氣質量：${level.label} (${level.color}色)\n` +
                          `📈 AQI 數值：${aqi}\n` +
                          `🌫️ PM2.5 濃度：${pm25}\n` +
                          `🌫️ PM10 濃度：${pm10}\n` +
                          `⏰ 更新時間：${time}\n\n` +
                          `👉 [點此查看詳細數據與地圖](${cityUrl})`;

            if (CONFIG.TG_TOKEN && CONFIG.TG_TOKEN !== 'xxx') {
                bot.telegram.sendMessage(CONFIG.TG_CHAT_ID, message, { parse_mode: 'Markdown' }).catch(tgError => {
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