// lib/scheduler.js — 定时系统
// 三件事：① config 里配的定时消息（早安/午安/晚安/自定义）② AI 用 set_reminder 设的提醒 ③ 每天跑一次记忆热度衰减
// 承自 eonnest scheduler.js，砍掉心声/做梦/催睡/位置触发/screentime乘数

'use strict';
const db = require('./db');
const embedding = require('./embedding');

module.exports = function createScheduler(deps) {
  const { config, engine, context, send } = deps;
  const firedToday = {};   // key: index → 日期字符串（每条每天只发一次）
  let lastDecayDate = '';
  let timer = null;

  function inCooldown() {
    const lastTs = db.getLastUserTs();
    if (!lastTs) return false;
    const cd = (config.scheduler?.cooldownMin || 15) * 60;
    return (Date.now() / 1000 - lastTs) < cd;
  }

  async function tick() {
    const today = context.todayStr();
    const hhmm = context.currentHHMM();

    // ③ 每日衰减（凌晨4点后第一次 tick）
    if (lastDecayDate !== today && context.currentHour() >= 4) {
      lastDecayDate = today;
      try { embedding.decayAllWeights(); } catch (e) { console.error('[scheduler] 衰减失败:', e.message); }
    }

    // ② 提醒：到点直接发（提醒内容是 AI 当时写好的话）
    try {
      const due = db.getDueReminders(Date.now() / 1000);
      for (const r of due) {
        db.markReminderSent(r.id);
        console.log('[reminder] 触发:', r.content.slice(0, 50));
        await send(r.content);
        engine.getHistory().push({ role: 'assistant', content: r.content, _ts: Date.now() / 1000, _proactive: true });
        db.archiveMessage('assistant', r.content, Date.now() / 1000, { source: 'reminder' });
      }
    } catch (e) { console.error('[reminder] 失败:', e.message); }

    // ① 定时消息
    if (!config.scheduler?.enabled) return;
    const list = config.scheduler.messages || [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || item.enabled === false || !item.time || !item.prompt) continue;
      if (item.time !== hhmm) continue;
      if (firedToday[i] === today) continue;
      firedToday[i] = today;
      if (inCooldown()) { console.log('[scheduler]', item.time, '刚聊过，跳过'); continue; }
      console.log('[scheduler] 触发', item.time);
      try {
        const reply = await engine.generateProactive(item.prompt, { source: 'scheduler' });
        if (reply) await send(reply);
      } catch (e) { console.error('[scheduler] 发送失败:', e.message); }
    }
  }

  function start() {
    if (timer) return;
    // 对齐到整分钟
    const delay = 60000 - (Date.now() % 60000);
    setTimeout(() => {
      tick().catch(e => console.error('[scheduler] tick异常:', e.message));
      timer = setInterval(() => tick().catch(e => console.error('[scheduler] tick异常:', e.message)), 60000);
    }, delay);
    console.log('[scheduler] 启动，定时消息', (config.scheduler?.messages || []).filter(m => m.enabled !== false).length, '条');
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { start, stop, tick };
};
