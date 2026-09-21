// lib/engine.js — 对话引擎（平台无关）
// 承自 eonnest engine.js v2.16.x，砍掉 desire/mood/管家/旅行/书房，补齐 Anthropic 官方 API 的工具调用格式
//
// prompt 结构（三个缓存断点，两家 API 都生效）：
//   BP① 人设 + 常驻记忆        → 固定，命中率最高
//   BP② 之前对话的滚动摘要      → 只在压缩时变
//   BP③ 对话历史（倒数第二条user挂标记）→ 每轮向前滚一格，前缀全命中
//   volatile: 关联记忆 + 时间 + 天气 → 塞进最后一条 user 消息前面，不进缓存

'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./db');
const retrieval = require('./retrieval');

const HISTORY_PATH = path.join(__dirname, '..', 'data', 'history.json');
const SUMMARY_MARK = '[之前对话的摘要]';
const MAX_TOOL_LOOPS = 5;

module.exports = function createEngine(deps) {
  const { config, persona, context, tools } = deps;
  const provider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

  // ===== history：内存 + json 落盘 =====
  let history = [];
  try { if (fs.existsSync(HISTORY_PATH)) history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch (e) { history = []; }
  function saveHistory() {
    try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 0)); } catch (e) { console.error('[engine] 历史保存失败:', e.message); }
  }
  function getHistory() { return history; }
  function clearHistory() { history = []; saveHistory(); }

  // ===== API 地址与头 =====
  function apiKey() {
    return provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENROUTER_API_KEY;
  }
  function apiUrl() {
    return provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://openrouter.ai/api/v1/chat/completions';
  }
  function headers() {
    if (provider === 'anthropic') return { 'x-api-key': apiKey(), 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
    return { 'Authorization': 'Bearer ' + apiKey(), 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/eonnest-lite', 'X-Title': 'eonnest-lite' };
  }
  function modelName(m) {
    // config 里统一写不带前缀的名字；OpenRouter 需要 anthropic/ 前缀
    if (provider === 'anthropic') return m.replace(/^anthropic\//, '');
    return m.includes('/') ? m : 'anthropic/' + m;
  }

  // ===== 工具格式转换 =====
  function toolsForProvider(defs) {
    if (!defs || defs.length === 0) return undefined;
    if (provider === 'anthropic') return defs.map(d => ({ name: d.name, description: d.description, input_schema: d.parameters }));
    return defs.map(d => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }));
  }

  // ===== 组装请求体 =====
  // msgs: [{role:'user'|'assistant'|'system', content}]（system 只可能是摘要）
  function buildRequestBody({ staticPrompt, summaryText, dynamicContext, msgs, maxTokens, includeTools }) {
    const cache = { type: 'ephemeral' };
    // 只剥掉 _ts 之类的内部字段，保留 tool_calls / tool_call_id（OpenRouter 工具回传要用）
    const chat = msgs.filter(m => m.role !== 'system').map(m => {
      const o = { role: m.role, content: m.content };
      if (m.tool_calls) o.tool_calls = m.tool_calls;
      if (m.tool_call_id) o.tool_call_id = m.tool_call_id;
      return o;
    });

    // volatile 注入：塞进最后一条 user 消息前面
    if (dynamicContext) {
      for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].role === 'user' && typeof chat[i].content === 'string') {
          chat[i] = { role: 'user', content: '<context>\n' + dynamicContext + '\n</context>\n\n' + chat[i].content };
          break;
        }
      }
    }

    // BP③：倒数第二条 user 消息挂缓存标记
    let userCount = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
      if (chat[i].role === 'user') {
        userCount++;
        if (userCount === 2 && typeof chat[i].content === 'string') {
          chat[i] = { role: 'user', content: [{ type: 'text', text: chat[i].content, cache_control: cache }] };
          break;
        }
      }
    }

    if (provider === 'anthropic') {
      const system = [{ type: 'text', text: staticPrompt, cache_control: cache }];
      if (summaryText) system.push({ type: 'text', text: summaryText, cache_control: cache });
      const body = { model: modelName(config.ai.model), system, messages: chat, max_tokens: maxTokens };
      if (includeTools) body.tools = toolsForProvider(tools.definitions);
      return body;
    }
    const sysMessages = [{ role: 'system', content: [{ type: 'text', text: staticPrompt, cache_control: cache }] }];
    if (summaryText) sysMessages.push({ role: 'system', content: [{ type: 'text', text: summaryText, cache_control: cache }] });
    const body = { model: modelName(config.ai.model), messages: [...sysMessages, ...chat], max_tokens: maxTokens, usage: { include: true } };
    if (includeTools) { body.tools = toolsForProvider(tools.definitions); body.tool_choice = 'auto'; }
    return body;
  }

  // ===== 解析响应成统一结构 =====
  // 返回 { text, toolCalls:[{id,name,args}], raw, usage:{input,output,cacheRead}, error }
  function parseResponse(data) {
    if (data.error) return { error: data.error.message || JSON.stringify(data.error) };
    if (provider === 'anthropic') {
      const blocks = data.content || [];
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const toolCalls = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} }));
      const u = data.usage || {};
      return { text, toolCalls, raw: blocks, usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 } };
    }
    const msg = data.choices?.[0]?.message || {};
    const text = (msg.content || '').trim();
    const toolCalls = (msg.tool_calls || []).map(tc => {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      return { id: tc.id, name: tc.function.name, args };
    });
    const u = data.usage || {};
    return { text, toolCalls, raw: msg, usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cacheRead: u.prompt_tokens_details?.cached_tokens || 0 } };
  }

  // 把"本轮 AI 的工具调用 + 结果"追加到临时消息列表（两家格式不同）
  function appendToolRound(chat, parsed, results) {
    if (provider === 'anthropic') {
      chat.push({ role: 'assistant', content: parsed.raw });
      chat.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.result).slice(0, 4000) })) });
    } else {
      chat.push(parsed.raw);
      for (const r of results) chat.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result).slice(0, 4000) });
    }
  }

  // ===== 带重试的 API 调用 =====
  async function callApi(body, onRetry) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180000);
      try {
        const res = await fetch(apiUrl(), { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: controller.signal });
        clearTimeout(timer);
        const data = await res.json().catch(() => ({ error: { message: 'HTTP ' + res.status } }));
        if ((!res.ok || data.error) && attempt < 2) {
          console.error('[engine] API错误 (第' + attempt + '次):', (data.error?.message || 'HTTP ' + res.status).slice(0, 200));
          await sleep(3000); if (onRetry) onRetry(); continue;
        }
        return data;
      } catch (e) {
        clearTimeout(timer);
        console.error('[engine] 请求异常 (第' + attempt + '次):', e.message);
        if (attempt < 2) { await sleep(3000); if (onRetry) onRetry(); continue; }
        return { error: { message: e.message } };
      }
    }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ===== token 估算（中日英混合，1字≈1.3tok）=====
  function estimateTokens(msgs) {
    return msgs.reduce((sum, m) => {
      const c = m.content;
      const len = typeof c === 'string' ? c.length : JSON.stringify(c || '').length;
      return sum + Math.ceil(len * 1.3);
    }, 0);
  }

  // ===== 组装三块 =====
  async function buildBlocks(userText, opts = {}) {
    const memories = await retrieval.loadMemories(userText, config.retrieval || {});
    const staticPrompt = persona.replace(/\{\{user\}\}/g, config.user?.name || 'TA').replace(/\{\{ai\}\}/g, config.ai?.name || 'AI')
      + (memories.pinned ? '\n\n【常驻记忆】\n' + memories.pinned : '');
    const summaryMsg = history.find(m => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_MARK));
    const summaryText = summaryMsg ? summaryMsg.content : '';
    const env = await context.buildDynamicContext({ forceWeather: !!opts.forceWeather });
    const dynamicContext = (memories.related ? '【关联记忆】\n' + memories.related + '\n\n' : '') + env + (opts.extraContext ? '\n' + opts.extraContext : '');
    return { staticPrompt, summaryText, dynamicContext };
  }

  // ===== 核心：处理一轮对话 =====
  // callbacks: { onTyping(), onToolNotify(text) }
  async function processConversation(userText, callbacks = {}) {
    const cb = callbacks;
    const t0 = Date.now();
    const userTs = Date.now() / 1000;
    if (cb.onTyping) cb.onTyping();

    const blocks = await buildBlocks(userText);
    history.push({ role: 'user', content: userText, _ts: userTs });
    const chat = [...history];

    let body = buildRequestBody({ ...blocks, msgs: chat, maxTokens: config.ai.maxTokens || 2000, includeTools: true });
    let data = await callApi(body, cb.onTyping);
    let parsed = parseResponse(data);
    if (parsed.error) { history.pop(); return { error: parsed.error, reply: '' }; }

    // 工具循环
    const toolLog = [];
    let loops = 0;
    let usage = { ...parsed.usage };
    while (parsed.toolCalls.length > 0 && loops < MAX_TOOL_LOOPS) {
      loops++;
      const results = [];
      for (const tc of parsed.toolCalls) {
        console.log('[FC]', tc.name, JSON.stringify(tc.args).slice(0, 150));
        const result = await tools.execute(tc.name, tc.args);
        results.push({ id: tc.id, result });
        toolLog.push({ name: tc.name, args: tc.args, ok: !result.error });
        if (cb.onToolNotify) {
          if (tc.name === 'memory' && tc.args.action === 'write' && result.ok) cb.onToolNotify('📝 记住了');
          if (tc.name === 'set_reminder' && result.ok) cb.onToolNotify('⏰ ' + result.message);
        }
      }
      appendToolRound(chat, parsed, results);
      if (cb.onTyping) cb.onTyping();
      body = buildRequestBody({ ...blocks, msgs: chat, maxTokens: config.ai.maxTokens || 2000, includeTools: true });
      data = await callApi(body, cb.onTyping);
      parsed = parseResponse(data);
      if (parsed.error) { history.pop(); return { error: parsed.error, reply: '' }; }
      usage.input += parsed.usage.input; usage.output += parsed.usage.output; usage.cacheRead += parsed.usage.cacheRead;
    }

    const reply = parsed.text || '';
    const duration = Date.now() - t0;
    if (reply) history.push({ role: 'assistant', content: reply, _ts: Date.now() / 1000 });
    else history.pop(); // 空回复：不留孤儿 user 消息
    saveHistory();

    db.archiveMessage('user', userText, userTs);
    if (reply) db.archiveMessage('assistant', reply, Date.now() / 1000, {
      model: config.ai.model, toolCalls: toolLog.length ? toolLog : null,
      inputTokens: usage.input, outputTokens: usage.output, cacheRead: usage.cacheRead, durationMs: duration
    });
    console.log('[engine] 完成 ' + duration + 'ms | in:' + usage.input + ' out:' + usage.output + ' cache:' + usage.cacheRead + (toolLog.length ? ' | tools:' + toolLog.map(t => t.name).join(',') : ''));

    // 摘要检查（异步，不阻塞回复）
    const tok = estimateTokens(history);
    if (tok > (config.chat?.summaryTrigger || 24000)) summarizeHistory().catch(e => console.error('[摘要] 异常:', e.message));

    return { reply, toolLog, usage, duration };
  }

  // ===== 主动消息（scheduler 用）=====
  // instruction: 系统给的指令（如"现在是早上，发一条起床消息"），不进 history 作为 user 消息，只作为一次性提示
  async function generateProactive(instruction, opts = {}) {
    const blocks = await buildBlocks(instruction, { forceWeather: true });
    const chat = [...history, { role: 'user', content: '[系统提示，不是对方说的话] ' + instruction + '\n请直接写出你要发给对方的消息，不要解释。' }];
    const body = buildRequestBody({ ...blocks, msgs: chat, maxTokens: config.ai.maxTokens || 2000, includeTools: false });
    const data = await callApi(body);
    const parsed = parseResponse(data);
    if (parsed.error) { console.error('[proactive] 失败:', parsed.error); return null; }
    const reply = parsed.text || '';
    if (!reply) return null;
    // 主动消息进历史（让后续对话知道自己说过什么），来源打标
    history.push({ role: 'assistant', content: reply, _ts: Date.now() / 1000, _proactive: true });
    saveHistory();
    db.archiveMessage('assistant', reply, Date.now() / 1000, { model: config.ai.model, source: opts.source || 'scheduler', inputTokens: parsed.usage.input, outputTokens: parsed.usage.output, cacheRead: parsed.usage.cacheRead });
    return reply;
  }

  // ===== 滚动摘要 =====
  let isSummarizing = false;
  async function summarizeHistory() {
    if (isSummarizing) return;
    isSummarizing = true;
    try {
      const aiName = config.ai?.name || 'AI', userName = config.user?.name || 'TA';
      const lines = [];
      let lastDate = '';
      for (const m of history) {
        if (m.role === 'system') { lines.push('[摘要]: ' + m.content.replace(SUMMARY_MARK, '').trim()); continue; }
        let ts = '', curDate = '';
        if (m._ts) {
          const d = new Date(m._ts * 1000);
          ts = '[' + d.toLocaleString('zh-CN', { timeZone: config.user?.timezone || 'Asia/Tokyo', hour12: false }).slice(0, 16) + '] ';
          curDate = d.toLocaleDateString('zh-CN', { timeZone: config.user?.timezone || 'Asia/Tokyo' });
        }
        if (curDate && lastDate && curDate !== lastDate) lines.push('━━━ 日期变更：' + lastDate + ' → ' + curDate + ' ━━━');
        if (curDate) lastDate = curDate;
        lines.push(ts + (m.role === 'user' ? userName : aiName) + ': ' + m.content);
      }
      const text = lines.join('\n\n');
      const before = estimateTokens(history);
      console.log('[摘要] 触发，历史', history.length, '条，约', before, 'tok');

      const sysPrompt = '现在是 ' + context.todayStr() + '。你是对话摘要管家，把下面的对话压缩成摘要。'
        + '第一人称：我=' + aiName + '，对方=' + userName + '。'
        + '保留：关键事件、对方的情绪走向、重要决定、约定、还没解决的事。'
        + '越近的越详细，越远的越概括。直接写内容，不要"根据对话"这类元叙述。800字以内。';

      let summary = await segmentedSummarize(text, sysPrompt);
      if (!summary) { await sleep(3000); summary = await segmentedSummarize(text, sysPrompt); }
      if (!summary) { smartTruncate('摘要失败'); return; }

      // 保留最近的对话（按 keepBudget）
      const budget = config.chat?.keepBudget || 8000;
      const kept = [];
      let accum = 0;
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i];
        if (m.role === 'system') continue;
        const tok = Math.ceil((m.content || '').length * 1.3);
        if (accum + tok > budget && kept.length >= 2) break;
        accum += tok;
        kept.unshift(m);
      }
      // 确保 kept 以 user 开头（Anthropic 要求）
      while (kept.length && kept[0].role !== 'user') kept.shift();
      history = [{ role: 'system', content: SUMMARY_MARK + '\n' + summary }, ...kept];
      saveHistory();
      console.log('[摘要] 完成', before, '→', estimateTokens(history), 'tok（' + history.length + '条）');
    } finally {
      isSummarizing = false;
    }
  }

  async function callSummaryApi(userText, sysPrompt) {
    const body = provider === 'anthropic'
      ? { model: modelName(config.ai.summaryModel || config.ai.model), system: sysPrompt, messages: [{ role: 'user', content: userText }], max_tokens: 1200 }
      : { model: modelName(config.ai.summaryModel || config.ai.model), messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userText }], max_tokens: 1200 };
    const data = await callApi(body);
    const parsed = parseResponse(data);
    if (parsed.error) { console.error('[摘要] API错误:', parsed.error); return null; }
    return parsed.text || null;
  }

  // 太长就分段压缩再合并（承自 eonnest v2.16.1 滚动式分段）
  async function segmentedSummarize(text, finalPrompt) {
    const THRESHOLD = 8000, SIZE = 6000;
    if (text.length <= THRESHOLD) return callSummaryApi('请摘要以下对话：\n\n' + text, finalPrompt);
    const segments = [];
    let remaining = text;
    while (remaining.length > SIZE * 1.2) {
      let cut = remaining.lastIndexOf('\n\n', SIZE);
      if (cut < SIZE * 0.4) cut = SIZE;
      segments.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) segments.push(remaining);
    console.log('[摘要] 分段压缩:', segments.length, '段');
    const parts = [];
    let prev = '';
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) await sleep(1500);
      const segSys = '这是第' + (i + 1) + '/' + segments.length + '段。' + (prev ? '【前面摘要】' + prev + '\n\n' : '') + '把这段对话压缩成300字左右，保留关键事件、情绪走向、决定。直接写内容。';
      const part = await callSummaryApi('请压缩以下片段：\n\n' + segments[i], segSys);
      if (part) { parts.push(part.trim()); prev = part.trim(); }
    }
    if (!parts.length) return null;
    const merged = parts.map((p, i) => '[第' + (i + 1) + '段] ' + p).join('\n\n');
    return callSummaryApi('以下是同一段对话的分段摘要（按时间顺序），请整合去重，重写成最终摘要：\n\n' + merged, finalPrompt);
  }

  function smartTruncate(reason) {
    const budget = config.chat?.keepBudget || 8000;
    const kept = [];
    let accum = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m.role === 'system') continue;
      const tok = Math.ceil((m.content || '').length * 1.3);
      if (accum + tok > budget && kept.length >= 4) break;
      accum += tok;
      kept.unshift(m);
    }
    while (kept.length && kept[0].role !== 'user') kept.shift();
    const old = history.find(m => m.role === 'system');
    history = old ? [old, ...kept] : kept;
    saveHistory();
    console.log('[摘要]', reason, '→ 硬砍，保留', history.length, '条');
  }

  return { processConversation, generateProactive, summarizeHistory, getHistory, clearHistory, estimateTokens, provider };
};
