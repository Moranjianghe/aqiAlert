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
    CHECK_INTERVAL: '*/30 * * * *', // 每 30 分鐘執行
    ALERT_THRESHOLD: 150            // 電報報警門檻 (中度污染以上)
};

const app = express();
const bot = new Telegraf(CONFIG.TG_TOKEN);

// 全局變量，存放狀態以實現「智慧提醒」
let currentRssXml = '';
let lastRssUpdateTime = 0; // 記錄上一次 RSS 更新的時間戳
// 紀錄每個等級 (1-4) 上一次發送 Telegram 報警的時間戳
let levelAlertTimestamps = {
    2: 0, // 輕度
    3: 0, // 中度
    4: 0  // 重度
};

// AQI 等級對應表 (增加 value 用於邏輯判斷)
const getAqiLevel = (aqi) => {
    if (aqi <= 50) return { value: 0, label: '優', color: '綠' };
    if (aqi <= 100) return { value: 1, label: '良', color: '黃' };
    if (aqi <= 150) return { value: 2, label: '輕度污染', color: '橘' };
    if (aqi <= 200) return { value: 3, label: '中度污染', color: '紅/橙' };
    return { value: 4, label: '重度污染', color: '紫' };
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
        const now = Date.now();
        
        // 提取主要污染物細節 (如果存在)
        const pm25 = data.iaqi.pm25 ? data.iaqi.pm25.v : 'N/A';
        const pm10 = data.iaqi.pm10 ? data.iaqi.pm10.v : 'N/A';

        console.log(`[${new Date().toLocaleString()}] 當前位置: ${city}, AQI: ${aqi} (${level.label})`);

        // 1. 邏輯判斷：高於橘色 (AQI > 100) 時，每 60 分鐘更新一次 RSS
        const isRssDue = (now - lastRssUpdateTime) >= 60 * 60 * 1000; // 60 分鐘
        if (aqi > 100 && isRssDue) {
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
                    description: `監測站位置: ${city}\n當前 AQI: ${aqi}\n健康等級: ${level.label}\n主要數據: PM2.5: ${pm25}, PM10: ${pm10}\n更新時間: ${time}\n請盡量減少戶外活動並佩戴口罩。`,
                    link: cityUrl,
                    date: new Date(),
                });
                currentRssXml = feed.rss2();
                lastRssUpdateTime = now;
                console.log('--- RSS 已更新 ---');
            } catch (rssError) {
                console.error('RSS 更新失敗:', rssError.message);
            }
        }

        // 2. 邏輯判斷：Telegram 智慧報警
        // 條件：(24 小時內未發過該等級警報) 且 (24 小時內未發過更高等級的警報)
        const hasRecentHigherOrSameAlert = Object.keys(levelAlertTimestamps).some(lv => {
            const levelVal = parseInt(lv);
            const timestamp = levelAlertTimestamps[lv];
            return levelVal >= level.value && (now - timestamp) < 24 * 60 * 60 * 1000;
        });

        if (aqi > CONFIG.ALERT_THRESHOLD && !hasRecentHigherOrSameAlert) {
            const message = `🚨🚨🚨 【緊急空氣預警】\n\n` +
                          `📍 監測地點：${city}\n` +
                          `🤒 空氣質量：${level.label} (${level.color}色)\n` +
                          `📈 AQI 數值：${aqi}\n` +
                          `🌫️ PM2.5 濃度：${pm25}\n` +
                          `🌫️ PM10 濃度：${pm10}\n` +
                          `⏰ 更新時間：${time}\n\n` +
                          `👉 [點此查看詳細數據與地圖](${cityUrl})`;

            if (CONFIG.TG_TOKEN && CONFIG.TG_TOKEN !== 'xxx') {
                bot.telegram.sendMessage(CONFIG.TG_CHAT_ID, message, { parse_mode: 'Markdown' })
                .then(() => {
                    levelAlertTimestamps[level.value] = now;
                    console.log(`--- Telegram 報警已發送 (等級: ${level.label}) ---`);
                })
                .catch(tgError => {
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