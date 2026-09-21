// lib/embedding.js — 向量检索 + 热度衰减
// 承自 eonnest embedding.js v1.0。没有 DASHSCOPE_API_KEY 时所有向量函数静默返回空，检索退化为纯 BM25。

'use strict';
const db = require('./db');

const DASHSCOPE_ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/embeddings';
const DASHSCOPE_MODEL = 'text-embedding-v4';
const DIMENSIONS = 512;

function enabled() {
  return !!process.env.DASHSCOPE_API_KEY;
}

// ===== 调 DashScope 算向量 =====
async function getEmbedding(text) {
  if (!enabled()) return null;
  if (!text || text.trim().length === 0) return null;
  try {
    const res = await fetch(DASHSCOPE_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.DASHSCOPE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: DASHSCOPE_MODEL, input: text.slice(0, 8000), dimensions: DIMENSIONS })
    });
    const data = await res.json();
    if (data.error) {
      console.error('[embedding] API错误:', data.error.message || JSON.stringify(data.error));
      return null;
    }
    return data.data?.[0]?.embedding || null;
  } catch (e) {
    console.error('[embedding] 调用失败:', e.message);
    return null;
  }
}

// ===== 余弦相似度 =====
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

// ===== RRF 融合（BM25 排名 + 向量排名 → 一个综合排名）=====
function rrfMerge(bm25Ranked, vectorRanked, k = 60) {
  const scores = {};
  bm25Ranked.forEach((id, rank) => { scores[id] = (scores[id] || 0) + 1 / (k + rank + 1); });
  vectorRanked.forEach((id, rank) => { scores[id] = (scores[id] || 0) + 1 / (k + rank + 1); });
  return Object.entries(scores).sort((a, b) => b[1] - a[1]).map(([id, score]) => ({ id, score }));
}

// ===== 向量检索：返回按相似度降序的记忆 id =====
function vectorSearch(queryEmbedding, memories, opts = {}) {
  if (!queryEmbedding) return [];
  const diaryThreshold = opts.diaryThreshold ?? 0.80;
  const normalThreshold = opts.normalThreshold ?? 0.40;
  const scored = [];
  for (const m of memories) {
    if (!m.embedding) continue;
    const sim = cosineSimilarity(queryEmbedding, m.embedding);
    const threshold = m.category === 'diary' ? diaryThreshold : normalThreshold;
    if (sim >= threshold) scored.push({ id: m.id, similarity: sim });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.map(s => s.id);
}

// ===== 语义去重（写入前检查是否已有意思差不多的）=====
function checkSemanticDuplicate(newEmbedding, allMemories, threshold = 0.90) {
  if (!newEmbedding) return null;
  let maxSim = 0, maxMem = null;
  for (const m of allMemories) {
    if (!m.embedding) continue;
    const sim = cosineSimilarity(newEmbedding, m.embedding);
    if (sim > maxSim) { maxSim = sim; maxMem = m; }
  }
  if (maxSim >= threshold && maxMem) {
    return { id: maxMem.id, content: maxMem.content.slice(0, 200), similarity: Math.round(maxSim * 1000) / 1000 };
  }
  return null;
}

// ===== 写入后异步补向量（不阻塞对话）=====
async function processAfterWrite(memId, content) {
  if (!enabled()) return { duplicateWarning: null };
  try {
    const emb = await getEmbedding(content);
    if (!emb) return { duplicateWarning: null };
    db.updateEmbedding(memId, emb);
    const others = db.getWithEmbedding().filter(m => m.id !== memId);
    const duplicateWarning = checkSemanticDuplicate(emb, others, 0.90);
    if (duplicateWarning) console.log('[embedding] ⚠️ 语义重复:', duplicateWarning.id, 'sim:', duplicateWarning.similarity);
    return { duplicateWarning };
  } catch (e) {
    console.error('[embedding] processAfterWrite失败:', e.message);
    return { duplicateWarning: null };
  }
}

// ===== 启动时给没有向量的旧记忆补算（限流）=====
async function backfillMissing() {
  if (!enabled()) return 0;
  const missing = db.getWithoutEmbedding();
  let n = 0;
  for (const m of missing) {
    const emb = await getEmbedding(m.content);
    if (emb) { db.updateEmbedding(m.id, emb); n++; }
    await new Promise(r => setTimeout(r, 200));
  }
  if (n > 0) console.log('[embedding] 补算向量:', n, '条');
  return n;
}

// ===== 热度：算当前有效权重 =====
// importance 影响半衰期：0.9→25日、0.5→14日、0.3→8日
// hits 越多半衰期越长（10次翻倍封顶），每次想起+2永久底温（上限20）
function calculateEffectiveWeight(memory) {
  if (memory.pinned) return memory.weight || 100;
  const now = Date.now();
  const lastDecay = memory.lastDecayAt ? new Date(memory.lastDecayAt).getTime() : now;
  const daysSince = (now - lastDecay) / 86400000;
  const imp = memory.importance || 0.5;
  const hits = memory.hits || 0;
  const halfLife = 14 * (imp / 0.5) * (1 + Math.min(hits, 10) * 0.1);
  const decayed = (memory.weight || 100) * Math.pow(0.5, daysSince / halfLife);
  return decayed + Math.min(20, hits * 2);
}

// ===== 热度：被检索到时回血 =====
function onRecall(memory) {
  memory.weight = Math.min((memory.weight || 100) + 20, 150);
  memory.hits = (memory.hits || 0) + 1;
  const now = new Date().toISOString();
  memory.lastAccessedAt = now;
  memory.lastDecayAt = now;
}

// ===== 热度：定期衰减（每天跑一次）=====
// 冷可以，死不可以：全记忆保底20；新记忆30天内保底60；deep/daily/diary 按 importance 有更高的地板
function decayAllWeights() {
  const memories = db.getUnpinned();
  const now = Date.now();
  let changed = 0;
  for (const m of memories) {
    if (!m.lastDecayAt) continue;
    const daysSince = (now - new Date(m.lastDecayAt).getTime()) / 86400000;
    if (daysSince < 0.5) continue;
    const imp = m.importance || 0.5;
    const hits = m.hits || 0;
    const halfLife = 14 * (imp / 0.5) * (1 + Math.min(hits, 10) * 0.1);
    let effective = (m.weight || 100) * Math.pow(0.5, daysSince / halfLife) + Math.min(20, hits * 2);
    const protectedCat = m.category === 'deep' || m.category === 'daily' || m.category === 'diary';
    if (protectedCat) {
      let floor;
      if (m.category === 'diary') floor = imp >= 0.8 ? 70 : imp >= 0.5 ? 50 : imp >= 0.4 ? 30 : 0;
      else floor = imp >= 0.8 ? 90 : imp >= 0.5 ? 70 : imp >= 0.4 ? 50 : 0;
      if (floor > 0 && effective < floor) effective = floor;
    }
    if (effective < 20) effective = 20;
    if (m.createdAt) {
      const ageDays = (now - new Date(m.createdAt).getTime()) / 86400000;
      if (ageDays < 30 && effective < 60) effective = 60;
    }
    db.updateDecay(m.id, Math.round(effective * 10) / 10, new Date().toISOString());
    changed++;
  }
  if (changed > 0) console.log('[embedding] 热度衰减:', changed, '条');
  return changed;
}

module.exports = {
  enabled, getEmbedding, cosineSimilarity, rrfMerge, vectorSearch,
  checkSemanticDuplicate, processAfterWrite, backfillMissing,
  calculateEffectiveWeight, onRecall, decayAllWeights
};
