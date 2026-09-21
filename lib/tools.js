// lib/tools.js — AI 能调用的工具
// 工具定义用统一格式 { name, description, parameters }，engine 负责转成 Anthropic / OpenRouter 各自的格式
// 承自 eonnest tools.js + tool-registry.js，砍到四个：memory / set_reminder / get_weather / web_search(可选)

'use strict';
const db = require('./db');
const embedding = require('./embedding');
const retrieval = require('./retrieval');

const CATEGORIES = ['deep', 'daily', 'diary', 'memo'];

module.exports = function createTools(deps) {
  const { config, context } = deps;
  const aiName = config.ai?.name || 'AI';
  const userName = config.user?.name || 'TA';

  // ===== 工具定义 =====
  const definitions = [
    {
      name: 'memory',
      description: '长期记忆。category: deep=关系核心/约定/重大事 | daily=' + userName + '的生活近况 | diary=' + aiName + '自己的感受和日记 | memo=杂项备忘。'
        + '写之前先 search 一下避免重复；已有的就 update。importance 0~1，默认0.5，很重要的给0.8以上。pinned=true 的记忆每轮都会看到，只给最核心的几条。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['write', 'search', 'update', 'delete', 'list'] },
          content: { type: 'string', description: 'write/update 时的内容' },
          category: { type: 'string', enum: CATEGORIES },
          tags: { type: 'array', items: { type: 'string' } },
          pinned: { type: 'boolean' },
          importance: { type: 'number' },
          query: { type: 'string', description: 'search 时的关键词，2~5个词，不要整句' },
          id: { type: 'string', description: 'update/delete 时的记忆 id' },
          date: { type: 'string', description: 'YYYY-MM-DD，按日期过滤' },
          limit: { type: 'number' }
        },
        required: ['action']
      }
    },
    {
      name: 'set_reminder',
      description: '设一个提醒，到时间会主动发消息。用于"X点提醒我"、"明天记得叫我"这类请求。至少填 in_minutes 或 at 其中一个。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '到时候要说的话，用你自己的口吻写' },
          in_minutes: { type: 'number', description: '多少分钟后' },
          at: { type: 'string', description: '绝对时间 YYYY-MM-DD HH:mm（本地时间），或只写 HH:mm 表示今天/明天最近的那个' }
        },
        required: ['content']
      }
    },
    {
      name: 'get_weather',
      description: '查当前天气和明天预报。平时天气会自动注入，只在' + userName + '专门问天气时调。',
      parameters: { type: 'object', properties: {} }
    }
  ];

  if (process.env.BRAVE_SEARCH_KEY) {
    definitions.push({
      name: 'web_search',
      description: '联网搜索。用于查你不知道的事实、最新消息。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    });
  }

  // ===== 执行 =====
  async function execute(name, args) {
    try {
      if (name === 'memory') return await execMemory(args || {});
      if (name === 'set_reminder') return execReminder(args || {});
      if (name === 'get_weather') return await execWeather();
      if (name === 'web_search') return await execSearch(args || {});
      return { error: '未知工具: ' + name };
    } catch (e) {
      console.error('[tools]', name, '执行失败:', e.message);
      return { error: e.message };
    }
  }

  async function execMemory(a) {
    const action = a.action;
    if (action === 'write') {
      if (!a.content) return { error: 'content 不能为空' };
      const id = db.insertMemory({
        content: a.content,
        category: CATEGORIES.includes(a.category) ? a.category : 'daily',
        tags: a.tags || [],
        pinned: !!a.pinned,
        importance: typeof a.importance === 'number' ? Math.max(0, Math.min(1, a.importance)) : 0.5
      });
      // 向量异步补，不阻塞
      embedding.processAfterWrite(id, a.content).then(r => {
        if (r.duplicateWarning) console.log('[memory] 可能与', r.duplicateWarning.id, '重复');
      }).catch(() => {});
      return { ok: true, id, message: '已记住' };
    }
    if (action === 'search') {
      const results = retrieval.searchMemories(a.query || '', { category: a.category, date: a.date, limit: a.limit || 8 });
      return {
        count: results.length,
        results: results.map(m => ({ id: m.id, category: m.category, content: m.content, tags: m.tags, createdAt: m.createdAt.slice(0, 16) }))
      };
    }
    if (action === 'list') {
      const results = db.listMemories({ category: a.category, date: a.date, limit: a.limit || 20 });
      return {
        count: results.length,
        stats: db.countMemories(),
        results: results.map(m => ({ id: m.id, category: m.category, content: m.content.slice(0, 120), pinned: m.pinned, createdAt: m.createdAt.slice(0, 10) }))
      };
    }
    if (action === 'update') {
      if (!a.id) return { error: '需要 id' };
      const ok = db.updateMemory(a.id, { content: a.content, category: a.category, tags: a.tags, pinned: a.pinned, importance: a.importance });
      if (ok && a.content) embedding.processAfterWrite(a.id, a.content).catch(() => {});
      return ok ? { ok: true, message: '已更新' } : { error: '找不到这条记忆' };
    }
    if (action === 'delete') {
      if (!a.id) return { error: '需要 id' };
      return db.deleteMemory(a.id) ? { ok: true, message: '已删除' } : { error: '找不到这条记忆' };
    }
    return { error: '未知 action: ' + action };
  }

  function execReminder(a) {
    if (!a.content) return { error: 'content 不能为空' };
    let fireAt = null;
    const nowSec = Date.now() / 1000;
    if (typeof a.in_minutes === 'number' && a.in_minutes > 0) {
      fireAt = nowSec + a.in_minutes * 60;
    } else if (a.at) {
      fireAt = parseLocalTime(a.at);
      if (fireAt == null) return { error: '时间格式不对，用 YYYY-MM-DD HH:mm 或 HH:mm' };
    } else {
      return { error: '需要 in_minutes 或 at' };
    }
    const id = db.addReminder(fireAt, a.content);
    const when = new Date(fireAt * 1000).toLocaleString('zh-CN', { timeZone: config.user?.timezone || 'Asia/Tokyo', hour12: false });
    return { ok: true, id, fireAt: when, message: '提醒已设：' + when };
  }

  // "HH:mm" 或 "YYYY-MM-DD HH:mm"（用户时区）→ 秒级时间戳
  function parseLocalTime(s) {
    const tz = config.user?.timezone || 'Asia/Tokyo';
    const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
    const m2 = s.match(/^(\d{1,2}):(\d{2})$/);
    let y, mo, d, h, mi;
    if (m1) { y = +m1[1]; mo = +m1[2]; d = +m1[3]; h = +m1[4]; mi = +m1[5]; }
    else if (m2) {
      const now = context.nowInTz();
      y = now.getFullYear(); mo = now.getMonth() + 1; d = now.getDate(); h = +m2[1]; mi = +m2[2];
    } else return null;
    // 把"目标时区的本地时间"转成 UTC 时间戳：先当 UTC 算，再用该时区的偏移修正
    const asUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
    const offsetMin = tzOffsetMinutes(tz, new Date(asUtc));
    let ts = (asUtc - offsetMin * 60000) / 1000;
    if (m2 && ts <= Date.now() / 1000) ts += 86400; // 只给了 HH:mm 且已过 → 明天
    return ts;
  }
  function tzOffsetMinutes(tz, date) {
    const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const loc = new Date(date.toLocaleString('en-US', { timeZone: tz }));
    return (loc - utc) / 60000;
  }

  async function execWeather() {
    const w = await context.fetchWeather(true);
    if (!w) return { error: '天气查不到，检查 config 里的 lat/lon' };
    return { weather: context.formatWeather(w) };
  }

  async function execSearch(a) {
    if (!a.query) return { error: 'query 不能为空' };
    const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(a.query) + '&count=5', {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_KEY }
    });
    const data = await res.json();
    const items = (data.web?.results || []).slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: r.description }));
    return { count: items.length, results: items };
  }

  return { definitions, execute };
};
