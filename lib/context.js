// lib/context.js — 每轮注入的环境信息
// 只留三样：当前时间、距离上次对话多久、天气（变化时才注入）
// 承自 eonnest context.js，砍掉电池/屏幕时间/健康/猫/歌单/日历/旅行

'use strict';
const db = require('./db');

const WEATHER_CODES = {
  0: '晴', 1: '晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '小雨', 53: '雨', 55: '大雨', 56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '雪', 75: '大雪', 77: '雪粒', 80: '阵雨', 81: '阵雨', 82: '暴雨',
  85: '阵雪', 86: '大阵雪', 95: '雷雨', 96: '雷雨冰雹', 99: '雷雨冰雹'
};
const WEATHER_EMOJI = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️', 45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌧️', 55: '🌧️', 56: '🌧️', 57: '🌧️',
  61: '🌦️', 63: '🌧️', 65: '🌧️', 66: '🌧️', 67: '🌧️',
  71: '🌨️', 73: '❄️', 75: '❄️', 77: '🌨️', 80: '🌦️', 81: '🌧️', 82: '⛈️',
  85: '🌨️', 86: '❄️', 95: '⛈️', 96: '⛈️', 99: '⛈️'
};

module.exports = function createContext(config) {
  const tz = config.user?.timezone || 'Asia/Tokyo';
  const WEATHER_CACHE_TTL = 3 * 60 * 60 * 1000;
  let weatherCache = { data: null, time: 0 };
  let lastInjected = { weather: '' };

  // ===== 时间 =====
  function nowInTz() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  }
  function getTimePrompt() {
    const d = nowInTz();
    const days = ['日', '一', '二', '三', '四', '五', '六'];
    const pad = n => String(n).padStart(2, '0');
    return '现在是 ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' 周' + days[d.getDay()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function todayStr() {
    const d = nowInTz();
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function currentHour() { return nowInTz().getHours(); }
  function currentHHMM() {
    const d = nowInTz();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ===== 对话间隔 =====
  function getGapContext() {
    try {
      const lastTs = db.getLastUserTs();
      if (!lastTs) return '';
      const gapMin = Math.round((Date.now() / 1000 - lastTs) / 60);
      if (gapMin < 15) return '';
      const s = gapMin < 120 ? gapMin + '分钟' : gapMin < 2880 ? Math.round(gapMin / 60) + '小时' : Math.round(gapMin / 1440) + '天';
      return '（距离上次对话约' + s + '。心里有数就好，不用每次点破。）';
    } catch (e) { return ''; }
  }

  // ===== 天气：Open-Meteo 直连，免费无 key =====
  async function fetchWeather(force) {
    const now = Date.now();
    if (!force && weatherCache.data && (now - weatherCache.time) < WEATHER_CACHE_TTL) return weatherCache.data;
    const lat = config.user?.lat, lon = config.user?.lon;
    if (lat == null || lon == null) return null;
    try {
      const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon
        + '&current=temperature_2m,weathercode,relative_humidity_2m,windspeed_10m'
        + '&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=' + encodeURIComponent(tz) + '&forecast_days=2';
      const res = await fetch(url);
      const wd = await res.json();
      if (!wd.current) return weatherCache.data || null;
      const result = {
        temp: wd.current.temperature_2m,
        weather: WEATHER_CODES[wd.current.weathercode] || '',
        emoji: WEATHER_EMOJI[wd.current.weathercode] || '🌡️',
        humidity: wd.current.relative_humidity_2m,
        wind: wd.current.windspeed_10m,
        location: config.user?.city || '',
        tomorrow: wd.daily ? {
          weather: WEATHER_CODES[wd.daily.weathercode[1]] || '',
          emoji: WEATHER_EMOJI[wd.daily.weathercode[1]] || '',
          max: wd.daily.temperature_2m_max[1], min: wd.daily.temperature_2m_min[1]
        } : null
      };
      weatherCache = { data: result, time: now };
      return result;
    } catch (e) {
      console.error('[天气] 查询失败:', e.message);
      return weatherCache.data || null;
    }
  }
  function formatWeather(w) {
    if (!w) return '';
    let s = w.location + ' ' + w.emoji + ' ' + w.temp + '°C ' + w.weather + ' 湿度' + w.humidity + '%';
    if (w.tomorrow) s += '｜明天 ' + w.tomorrow.emoji + ' ' + w.tomorrow.weather + ' ' + w.tomorrow.min + '~' + w.tomorrow.max + '°C';
    return s;
  }
  // 变化时才注入：连续几轮天气没变就不重复塞进 prompt，省 token
  async function getWeatherContext(force) {
    const w = await fetchWeather(false);
    const text = formatWeather(w);
    if (!text) return '';
    if (!force && text === lastInjected.weather) return '';
    lastInjected.weather = text;
    return '天气：' + text;
  }

  // ===== 组装动态上下文 =====
  async function buildDynamicContext(opts = {}) {
    const parts = [getTimePrompt()];
    const gap = getGapContext();
    if (gap) parts.push(gap);
    const weather = await getWeatherContext(!!opts.forceWeather);
    if (weather) parts.push(weather);
    return parts.join('\n');
  }

  return { getTimePrompt, todayStr, currentHour, currentHHMM, nowInTz, getGapContext, fetchWeather, formatWeather, getWeatherContext, buildDynamicContext };
};

// ===== 给 setup 用：城市名 → 经纬度（Open-Meteo geocoding，免费）=====
module.exports.geocode = async function geocode(cityName) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(cityName) + '&count=1&language=zh';
  const res = await fetch(url);
  const data = await res.json();
  const r = data.results && data.results[0];
  if (!r) return null;
  return { name: r.name, lat: r.latitude, lon: r.longitude, timezone: r.timezone, country: r.country };
};
