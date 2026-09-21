// index.js — eonnest-lite 入口
// Telegram long polling（不需要域名/证书/nginx），装配 engine / context / tools / scheduler
// 承自 eonnest gateway.js，砍掉 webhook/语音/识图/网页端/所有 REST 路由

'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Bot } = require('grammy');

// ===== 读配置 =====
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PERSONA_PATH = path.join(__dirname, 'persona.md');
function die(msg) { console.error('[FATAL] ' + msg); process.exit(1); }
if (!fs.existsSync(CONFIG_PATH)) die('找不到 config.json，先跑 npm run setup');
if (!fs.existsSync(PERSONA_PATH)) die('找不到 persona.md，先跑 npm run setup');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const persona = fs.readFileSync(PERSONA_PATH, 'utf8');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = Number(process.env.TELEGRAM_OWNER_ID);
const PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
if (!TOKEN) die('.env 里没有 TELEGRAM_BOT_TOKEN');
if (!OWNER_ID) die('.env 里没有 TELEGRAM_OWNER_ID');
if (PROVIDER === 'anthropic' && !process.env.ANTHROPIC_API_KEY) die('LLM_PROVIDER=anthropic 但 .env 里没有 ANTHROPIC_API_KEY');
if (PROVIDER === 'openrouter' && !process.env.OPENROUTER_API_KEY) die('LLM_PROVIDER=openrouter 但 .env 里没有 OPENROUTER_API_KEY');

// ===== 装配 =====
const db = require('./lib/db');
const embedding = require('./lib/embedding');
const context = require('./lib/context')(config);
const tools = require('./lib/tools')({ config, context });
const engine = require('./lib/engine')({ config, persona, context, tools });
const bot = new Bot(TOKEN);

async function send(text) {
  const chunks = splitReply(text);
  for (let i = 0; i < chunks.length; i++) {
    await bot.api.sendMessage(OWNER_ID, chunks[i]);
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 600 + Math.min(chunks[i].length * 15, 2000)));
  }
}
// 按空行拆成多条发，像发微信；单条超过 3500 字再硬切（Telegram 上限 4096）
function splitReply(text) {
  const parts = (text || '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length <= 3500) out.push(p);
    else for (let i = 0; i < p.length; i += 3500) out.push(p.slice(i, i + 3500));
  }
  return out.length ? out : ['…'];
}

const scheduler = require('./lib/scheduler')({ config, engine, context, send });

// ===== 消息缓冲：几秒内连发的几条合成一条处理 =====
let buffer = [];
let bufferTimer = null;
let processing = false;
let pendingAfter = null;

function enqueue(text) {
  buffer.push(text);
  if (bufferTimer) clearTimeout(bufferTimer);
  bufferTimer = setTimeout(flush, (config.chat?.bufferSec || 3) * 1000);
}
async function flush() {
  bufferTimer = null;
  if (processing) { pendingAfter = true; return; }
  const combined = buffer.join('\n');
  buffer = [];
  if (!combined.trim()) return;
  processing = true;
  try {
    let typingTimer = null;
    const typing = () => {
      bot.api.sendChatAction(OWNER_ID, 'typing').catch(() => {});
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = setTimeout(typing, 4500);
    };
    typing();
    const r = await engine.processConversation(combined, {
      onTyping: typing,
      onToolNotify: t => bot.api.sendMessage(OWNER_ID, t).catch(() => {})
    });
    clearTimeout(typingTimer);
    if (r.error) await bot.api.sendMessage(OWNER_ID, '（出错了：' + r.error.slice(0, 200) + '）');
    else if (r.reply) await send(r.reply);
  } catch (e) {
    console.error('[index] 处理失败:', e.message);
    await bot.api.sendMessage(OWNER_ID, '（出错了：' + e.message.slice(0, 200) + '）').catch(() => {});
  } finally {
    processing = false;
    if (pendingAfter) { pendingAfter = null; if (buffer.length) flush(); }
  }
}

// ===== 命令 =====
bot.command('start', ctx => ctx.reply('在的。直接说话就行。\n/help 看命令'));
bot.command('help', ctx => ctx.reply(
  '/clear — 清空对话上下文（记忆不会丢）\n'
  + '/memory — 看记忆统计\n'
  + '/reminders — 看待发提醒\n'
  + '/summary — 手动压缩一次对话历史\n'
  + '/weather — 现在的天气'
));
bot.command('clear', ctx => { engine.clearHistory(); return ctx.reply('对话上下文清了，记忆还在'); });
bot.command('memory', ctx => {
  const s = db.countMemories();
  return ctx.reply('记忆 ' + s.total + ' 条：' + Object.entries(s).filter(([k]) => k !== 'total').map(([k, v]) => k + ' ' + v).join(' / ')
    + '\n向量检索：' + (embedding.enabled() ? '开' : '关（没配 DASHSCOPE_API_KEY）'));
});
bot.command('reminders', ctx => {
  const list = db.listPendingReminders();
  if (!list.length) return ctx.reply('没有待发的提醒');
  const tz = config.user?.timezone || 'Asia/Tokyo';
  return ctx.reply(list.map(r => new Date(r.fireAt * 1000).toLocaleString('zh-CN', { timeZone: tz, hour12: false }) + '  ' + r.content.slice(0, 40)).join('\n'));
});
bot.command('summary', async ctx => { await ctx.reply('压缩中…'); await engine.summarizeHistory(); return ctx.reply('压缩完成，现在历史 ' + engine.getHistory().length + ' 条'); });
bot.command('weather', async ctx => { const w = await context.fetchWeather(true); return ctx.reply(w ? context.formatWeather(w) : '查不到，检查 config 里的坐标'); });

// ===== 消息 =====
bot.on('message', async ctx => {
  if (ctx.from?.id !== OWNER_ID) return; // 只理主人
  if (ctx.message.text) { if (!ctx.message.text.startsWith('/')) enqueue(ctx.message.text); return; }
  if (ctx.message.photo) return ctx.reply('（这个版本还看不了图，可以用文字描述给我）');
  if (ctx.message.voice) return ctx.reply('（这个版本还听不了语音，打字给我）');
  if (ctx.message.sticker) enqueue('[发了一个贴纸' + (ctx.message.sticker.emoji ? ' ' + ctx.message.sticker.emoji : '') + ']');
});

bot.catch(err => console.error('[bot]', err.message));

// ===== 启动 =====
(async () => {
  db.getDB();
  console.log('[boot] eonnest-lite | provider:', PROVIDER, '| model:', config.ai.model, '| 向量:', embedding.enabled() ? 'on' : 'off');
  embedding.backfillMissing().catch(() => {});
  scheduler.start();
  await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
  bot.start({ onStart: info => console.log('[boot] 已连接 Telegram @' + info.username + '，等消息中') });
})();

process.on('SIGINT', () => { scheduler.stop(); bot.stop(); process.exit(0); });
process.on('SIGTERM', () => { scheduler.stop(); bot.stop(); process.exit(0); });
