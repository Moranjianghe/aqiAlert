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
    ALERT_THRESHOLD: 150            // 電報報警門檻 (不健康以上)
};

const app = express();
const bot = new Telegraf(CONFIG.TG_TOKEN);

// 全局變量，存放狀態以實現「智慧提醒」
let currentRssXml = '';
let lastRssUpdateTime = 0; // 記錄上一次 RSS 更新的時間戳
// 紀錄每個等級 (2-5) 上一次發送 Telegram 報警的時間戳
let levelAlertTimestamps = {
    2: 0, // 對敏感族群不健康
    3: 0, // 不健康
    4: 0, // 非常不健康
    5: 0  // 危害
};

// AQI 等級對應表 (依據 US EPA AQI 標準)
const getAqiLevel = (aqi) => {
    if (aqi <= 50) return { value: 0, label: '良好', color: '綠' };
    if (aqi <= 100) return { value: 1, label: '普通', color: '黃' };
    if (aqi <= 150) return { value: 2, label: '對敏感族群不健康', color: '橘' };
    if (aqi <= 200) return { value: 3, label: '不健康', color: '紅' };
    if (aqi <= 300) return { value: 4, label: '非常不健康', color: '紫' };
    return { value: 5, label: '危害', color: '褐紅' };
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
        const dominentpol = data.dominentpol;
        const level = getAqiLevel(aqi);
        const now = Date.now();
        
        // 提取所有可用的 iaqi 數據並轉換為友善名稱
        const pollutantMap = {
            pm25: 'PM2.5',
            pm10: 'PM10',
            o3: '臭氧 (O3)',
            no2: '二氧化氮 (NO2)',
            so2: '二氧化硫 (SO2)',
            co: '一氧化碳 (CO)',
            t: '溫度',
            p: '氣壓',
            h: '濕度',
            dew: '露點',
            w: '風速',
            wg: '陣風'
        };

        // 提取所有可用的 iaqi 數據並轉換為友善名稱 (HTML 格式)
        let detailsHtml = '<ul>';
        if (data.iaqi) {
            Object.keys(data.iaqi).forEach(key => {
                const label = pollutantMap[key] || key.toUpperCase();
                const value = data.iaqi[key].v;
                let unit = '';
                if (key === 't' || key === 'dew') unit = '°C';
                if (key === 'h') unit = '%';
                if (key === 'p') unit = ' hPa';
                if (key === 'w' || key === 'wg') unit = ' m/s';
                detailsHtml += `<li><strong>${label}</strong>: ${value}${unit}</li>`;
            });
        }
        detailsHtml += '</ul>';

        // 提取預報信息 (Forecast - HTML 格式)
        let forecastHtml = '<ul>';
        if (data.forecast && data.forecast.daily && data.forecast.daily.pm25) {
            const todayStr = new Date().toISOString().split('T')[0];
            data.forecast.daily.pm25
                .filter(f => f.day >= todayStr)
                .slice(0, 3)
                .forEach(f => {
                    const fLevel = getAqiLevel(f.avg);
                    forecastHtml += `<li>📅 <strong>${f.day}</strong>: AQI ${f.avg} <span style="color:gray;">[${fLevel.label}]</span> (範圍: ${f.min}-${f.max})</li>`;
                });
        }
        forecastHtml += '</ul>';

        // 提取貢獻單位 (Attributions - HTML 格式)
        const attributionsHtml = data.attributions ? data.attributions.map(a => `<a href="${a.url}">${a.name}</a>`).join(', ') : '未知';

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
                    description: `
                        <p>📍 <strong>監測站</strong>: ${city}</p>
                        <p>📊 <strong>當前 AQI</strong>: <span style="font-size:1.2em; color:#d9534f;">${aqi}</span> (${level.label})</p>
                        <p>🧪 <strong>主要污染物</strong>: ${pollutantMap[dominentpol] || dominentpol}</p>
                        <hr/>
                        <h4>📝 詳細監測數據</h4>
                        ${detailsHtml}
                        <hr/>
                        <h4>🔮 未來三天預報</h4>
                        ${forecastHtml}
                        <hr/>
                        <p>🕒 <strong>更新時間</strong>: ${time}</p>
                        <p>📢 <strong>數據來源</strong>: ${attributionsHtml}</p>
                        <p>✅ <em>建議: 請盡量減少戶外活動並佩戴口罩。</em></p>
                    `,
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

        // 為了 Telegram 報警，我們仍需要一個純文字版的 detailsStr
        const detailsStr = data.iaqi ? Object.keys(data.iaqi).map(key => {
            const label = pollutantMap[key] || key.toUpperCase();
            const value = data.iaqi[key].v;
            return `${label}: ${value}`;
        }).join('\n') : '暫無詳細數據';

        if (aqi > CONFIG.ALERT_THRESHOLD && !hasRecentHigherOrSameAlert) {
            const message = `🚨 *空氣品質警報：${level.label}*\n\n` +
                          `📍 地點：${city}\n` +
                          `📈 AQI 數值：*${aqi}* (${level.color}色)\n` +
                          `🧪 主污染物：${pollutantMap[dominentpol] || dominentpol}\n\n` +
                          `💡 建議：請盡量減少戶外活動並佩戴口罩。\n\n` +
                          `👉 [查看完整數據、詳細分析與預報](${cityUrl})`;

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
app.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(`服務已啟動，監聽埠號: ${CONFIG.PORT}`);
    updateAqiTask(); // 啟動時先執行一次
});