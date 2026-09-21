// setup.js — 交互式初始化
// 在终端问几个问题，自动生成 .env / config.json / persona.md
// 跑法：npm run setup

'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { geocode } = require('./lib/context');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def) => new Promise(res => rl.question(q + (def ? ' [' + def + ']' : '') + '\n> ', a => res((a || '').trim() || def || '')));
const ROOT = __dirname;

(async () => {
  console.log('\n===== eonnest-lite 初始化 =====\n回答几个问题就好，回车用默认值。\n');

  // ---- Telegram ----
  console.log('【1/6】Telegram');
  console.log('  没有 bot 的话：在 Telegram 搜 @BotFather，发 /newbot，起个名字，会给你一串 token');
  const tgToken = await ask('Bot Token');
  if (!tgToken) { console.log('token 不能为空'); process.exit(1); }
  console.log('  你的数字 ID：在 Telegram 搜 @userinfobot，随便发一条消息，它会回你一串数字');
  const tgOwner = await ask('你的 Telegram 数字 ID');
  if (!/^\d+$/.test(tgOwner)) { console.log('ID 应该是纯数字'); process.exit(1); }

  // ---- API ----
  console.log('\n【2/6】AI 模型的 API');
  console.log('  1 = Anthropic 官方（console.anthropic.com）\n  2 = OpenRouter（openrouter.ai，能用各家模型）');
  const p = await ask('用哪家？输 1 或 2', '1');
  const provider = p === '2' ? 'openrouter' : 'anthropic';
  const apiKey = await ask(provider === 'anthropic' ? 'Anthropic API Key' : 'OpenRouter API Key');
  if (!apiKey) { console.log('key 不能为空'); process.exit(1); }
  const defaultModel = 'claude-sonnet-4-6';
  const model = await ask('主模型（回车用默认）', defaultModel);
  const summaryModel = await ask('压缩摘要用的便宜模型（回车用默认）', 'claude-haiku-4.5');

  // ---- 名字 ----
  console.log('\n【3/6】名字');
  const aiName = await ask('你的 AI 叫什么', '小季');
  const userName = await ask('TA 怎么称呼你', '你');

  // ---- 城市 ----
  console.log('\n【4/6】城市（用于天气和时区）');
  let city = await ask('你在哪个城市（中文/英文都行）', 'Tokyo');
  let geo = null;
  try { geo = await geocode(city); } catch (e) {}
  if (geo) {
    console.log('  → 找到了：' + geo.name + (geo.country ? ', ' + geo.country : '') + '（' + geo.timezone + '）');
  } else {
    console.log('  → 没查到这个城市，先用东京的坐标，之后可以改 config.json');
    geo = { name: city, lat: 35.6762, lon: 139.6503, timezone: 'Asia/Tokyo' };
  }

  // ---- 可选 ----
  console.log('\n【5/6】可选功能（直接回车跳过）');
  console.log('  语义检索：让 AI 按"意思"找记忆而不是只按关键词。要阿里云百炼的 key（dashscope.console.aliyun.com，国际版），有免费额度');
  const dashKey = await ask('DashScope API Key（可选）');
  console.log('  联网搜索：要 Brave Search 的 key（brave.com/search/api），有免费档');
  const braveKey = await ask('Brave Search Key（可选）');

  // ---- 人设 ----
  console.log('\n【6/6】人设');
  console.log('  会生成 persona.md，用默认模板再自己改最省事。写人设就是写"TA是谁、怎么说话、跟你什么关系"。');
  const usePersonaTpl = await ask('先用默认模板？y/n', 'y');

  // ---- 写文件 ----
  const env = [
    'TELEGRAM_BOT_TOKEN=' + tgToken,
    'TELEGRAM_OWNER_ID=' + tgOwner,
    'LLM_PROVIDER=' + provider,
    'ANTHROPIC_API_KEY=' + (provider === 'anthropic' ? apiKey : ''),
    'OPENROUTER_API_KEY=' + (provider === 'openrouter' ? apiKey : ''),
    'DASHSCOPE_API_KEY=' + dashKey,
    'BRAVE_SEARCH_KEY=' + braveKey,
    ''
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, '.env'), env);

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  cfg.ai.name = aiName;
  cfg.ai.model = model;
  cfg.ai.summaryModel = summaryModel;
  cfg.user.name = userName;
  cfg.user.city = geo.name;
  cfg.user.lat = geo.lat;
  cfg.user.lon = geo.lon;
  cfg.user.timezone = geo.timezone;
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfg, null, 2));

  if (usePersonaTpl.toLowerCase() !== 'n' || !fs.existsSync(path.join(ROOT, 'persona.md'))) {
    let tpl = fs.readFileSync(path.join(ROOT, 'persona.example.md'), 'utf8');
    tpl = tpl.replace(/小季/g, aiName);
    fs.writeFileSync(path.join(ROOT, 'persona.md'), tpl);
  }
  if (!fs.existsSync(path.join(ROOT, 'data'))) fs.mkdirSync(path.join(ROOT, 'data'));

  console.log('\n===== 完成 =====');
  console.log('生成了：.env / config.json / persona.md');
  console.log('接下来：');
  console.log('  1. 打开 persona.md 改成你想要的人设（现在改或者以后改都行）');
  console.log('  2. npm start 启动');
  console.log('  3. 去 Telegram 找你的 bot 发一句话\n');
  rl.close();
})().catch(e => { console.error('初始化失败:', e.message); rl.close(); process.exit(1); });
