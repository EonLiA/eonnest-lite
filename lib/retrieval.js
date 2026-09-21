// lib/retrieval.js — BM25 + 向量混合检索
// 承自 eonnest retrieval.js。砍掉了 FEEL 情绪分类、resolved 沉底、travel 过滤。
// 流程：分词 → BM25打分 → 向量检索 → RRF融合 → 热度加权 → 取topK → 回血

'use strict';
const db = require('./db');
const embedding = require('./embedding');

// ===== 分词：中日韩单字+bigram，英文按空格 =====
function tokenize(text) {
  if (!text) return [];
  const tokens = [];
  const normalized = text.toLowerCase().replace(/[^\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g, ' ');
  const parts = normalized.split(/\s+/).filter(Boolean);
  const cjk = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
  for (const part of parts) {
    const cjkMatch = part.match(new RegExp(cjk.source, 'g'));
    if (cjkMatch && cjkMatch.length > part.length * 0.5) {
      const chars = [...part].filter(c => cjk.test(c));
      for (const c of chars) tokens.push(c);
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
    } else if (part.length > 0) {
      tokens.push(part);
    }
  }
  return tokens;
}

// ===== BM25 =====
const BM25_K1 = 1.5;
const BM25_B = 0.75;

function bm25Score(queryTokens, docs) {
  const docTokens = docs.map(d => d._tokens);
  const docLengths = docTokens.map(t => t.length);
  const avgDL = docLengths.reduce((a, b) => a + b, 0) / (docs.length || 1);
  const N = docs.length;
  const df = {};
  for (const term of queryTokens) {
    if (df[term] !== undefined) continue;
    let count = 0;
    for (const dt of docTokens) if (dt.includes(term)) count++;
    df[term] = count;
  }
  const scores = {};
  for (let i = 0; i < docs.length; i++) {
    const dl = docLengths[i];
    const tf = {};
    for (const t of docTokens[i]) tf[t] = (tf[t] || 0) + 1;
    let score = 0;
    for (const term of queryTokens) {
      const termTF = tf[term] || 0;
      if (termTF === 0) continue;
      const idf = Math.log((N - df[term] + 0.5) / (df[term] + 0.5) + 1);
      score += idf * (termTF * (BM25_K1 + 1)) / (termTF + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgDL));
    }
    scores[docs[i].id] = score;
  }
  return scores;
}

// ===== 混合检索 =====
// 返回 { pinned: string, related: string }，直接塞进 prompt
async function loadMemories(userMessage, cfg = {}) {
  try {
    const pinned = db.getPinned();
    const unpinned = db.getUnpinned();
    const TOP_K = cfg.topK || 6;
    const MIN_SCORE = cfg.minScore || 0.4;
    const DIARY_MIN = cfg.diaryMin || 1.5;

    const queryTokens = [...new Set(tokenize(userMessage))];
    const docs = unpinned.map(m => {
      const searchText = [m.content || '', (m.tags || []).join(' ')].join(' ');
      return { id: m.id, _tokens: tokenize(searchText), _mem: m };
    });
    const rawScores = bm25Score(queryTokens, docs);

    const scoredDocs = docs.map(d => {
      const m = d._mem;
      const score = (rawScores[d.id] || 0) * (m.importance || 0.5);
      const minScore = m.category === 'diary' ? DIARY_MIN : MIN_SCORE;
      return { mem: m, score, minScore };
    });

    let queryEmbedding = null;
    try { queryEmbedding = await embedding.getEmbedding(userMessage); } catch (e) {}

    let qualified;
    if (queryEmbedding) {
      const vectorRanked = embedding.vectorSearch(queryEmbedding, unpinned);
      const bm25Ranked = scoredDocs.filter(d => d.score >= d.minScore).sort((a, b) => b.score - a.score).map(d => d.mem.id);
      const merged = embedding.rrfMerge(bm25Ranked, vectorRanked);
      for (const r of merged) {
        const mem = unpinned.find(u => u.id === r.id);
        if (mem) r.score *= embedding.calculateEffectiveWeight(mem) / 100;
      }
      merged.sort((a, b) => b.score - a.score);
      const top = merged.slice(0, TOP_K);
      const idSet = new Set(top.map(t => t.id));
      qualified = scoredDocs.filter(d => idSet.has(d.mem.id))
        .map(d => ({ ...d, rrfScore: (top.find(t => t.id === d.mem.id) || {}).score || 0 }))
        .sort((a, b) => b.rrfScore - a.rrfScore);
    } else {
      qualified = scoredDocs.filter(d => d.score >= d.minScore)
        .map(d => { d.score *= embedding.calculateEffectiveWeight(d.mem) / 100; return d; })
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_K);
    }

    // 回血
    for (const q of qualified) {
      embedding.onRecall(q.mem);
      db.updateRecall(q.mem.id, q.mem.weight, q.mem.hits, q.mem.lastAccessedAt, q.mem.lastDecayAt);
    }

    const fmtTags = tags => (tags && tags.length) ? ' [' + tags.join(', ') + ']' : '';
    const pinnedStr = pinned.map(m => '---\n📌' + fmtTags(m.tags) + '\n' + m.content).join('\n');
    const relatedStr = qualified.map(d => '---\n🔑' + fmtTags(d.mem.tags) + '\n' + d.mem.content).join('\n');

    console.log('[retrieval]', queryEmbedding ? 'BM25+向量' : 'BM25', '| pinned:', pinned.length, '| related:', qualified.length);
    return { pinned: pinnedStr, related: relatedStr };
  } catch (e) {
    console.error('[retrieval] 失败:', e.message);
    return { pinned: '', related: '' };
  }
}

// ===== 给工具用的关键词搜索（search 动作）=====
function searchMemories(query, opts = {}) {
  const all = db.listMemories({ category: opts.category, date: opts.date });
  if (!query) return all.slice(0, opts.limit || 10);
  const queryTokens = [...new Set(tokenize(query))];
  const docs = all.map(m => ({ id: m.id, _tokens: tokenize(m.content + ' ' + (m.tags || []).join(' ')), _mem: m }));
  const scores = bm25Score(queryTokens, docs);
  return docs.map(d => ({ mem: d._mem, score: scores[d.id] || 0 }))
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit || 10)
    .map(d => d.mem);
}

module.exports = { loadMemories, searchMemories, tokenize };
