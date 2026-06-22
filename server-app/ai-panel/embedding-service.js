// ============================================================================
// embedding-service.js — 文本向量化服务 (纯 JS)
// 调用 AiGateway.embed() 统一包装器
// 支持单文本 + batch（最多 10 条/请求），返回归一化向量
// 暴露为 window._qqqEmbedding = { embedText, embedBatch, cosineSimilarity, rerankWithEmbedding }
// ============================================================================

var EMBEDDING_BATCH_MAX = 10;
var EMBEDDING_DIMS = 1024;
var EMBEDDING_LOG = false; // ★ 开关：设 true 开启底层 API 日志

/**
 * 获取单个文本的向量
 * @param {string} text
 * @param {string} authToken
 * @param {string} [floorID]
 * @returns {Promise<{vectors: number[][], tokenCount: number, model: string}>}
 */
async function embedText(text, authToken, floorID) {
    return embedBatch([text], authToken, floorID);
}

/**
 * 批量获取向量（最多 10 条/请求，自动分批）
 * @param {string[]} texts
 * @param {string} authToken
 * @param {string} [floorID]
 * @returns {Promise<{vectors: number[][], tokenCount: number, model: string}>}
 */
async function embedBatch(texts, authToken, floorID) {
    if (!texts || texts.length === 0) return { vectors: [], tokenCount: 0, model: 'embedding-v1' };

    if (typeof AiGateway === 'undefined' || !AiGateway.embed) {
        if (EMBEDDING_LOG) console.log('[embed] AiGateway not available');
        return { vectors: [], tokenCount: 0, model: 'embedding-v1' };
    }

    var allVectors = [];
    var totalTokens = 0;
    var model = 'embedding-v1';
    var batches = Math.ceil(texts.length / EMBEDDING_BATCH_MAX);
    if (EMBEDDING_LOG) console.log('[embed] embedBatch: ' + texts.length + ' texts → ' + batches + ' batch(es), floor=' + (floorID || '(new quest)'));

    // 分批调用（每批 ≤ EMBEDDING_BATCH_MAX）
    for (var i = 0; i < texts.length; i += EMBEDDING_BATCH_MAX) {
        var batch = texts.slice(i, i + EMBEDDING_BATCH_MAX);
        if (EMBEDDING_LOG) console.log('[embed] batch ' + (Math.floor(i / EMBEDDING_BATCH_MAX) + 1) + '/' + batches + ': ' + batch.length + ' texts');
        try {
            var result = await AiGateway.embed(batch, { token: authToken, floorId: floorID });
            allVectors.push.apply(allVectors, result.vectors);
            totalTokens += result.tokenCount;
            model = result.model;
        } catch (err) {
            if (EMBEDDING_LOG) console.log('[embed] batch failed: ' + (err.message || err));
            throw err;
        }
    }

    if (EMBEDDING_LOG) console.log('[embed] done: ' + allVectors.length + ' vectors, ' + totalTokens + ' tokens');
    return { vectors: allVectors, tokenCount: totalTokens, model: model };
}

/**
 * 余弦相似度（向量需已归一化）
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
    var dot = 0;
    for (var i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
    }
    return dot; // 归一化后 dot product = cosine
}

/**
 * 用 query embedding 重排 BM25 结果
 * @param {number[]} queryVec 查询向量（已归一化）
 * @param {Array<{score: number}>} candidates BM25 候选
 * @param {number[][]} docVecs 文档向量（与 candidates 同序，已归一化）
 * @returns {Array} 混合排序后的 candidates（加 _hybridScore 字段）
 */
function rerankWithEmbedding(queryVec, candidates, docVecs) {
    var alpha = 0.3; // embedding 权重（BM25 权重 = 1 - alpha = 0.7）
    var reranked = [];
    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var bm25Norm = Math.min((c.score || 0) / 20, 1); // BM25 归一化（假设 max ~20）
        var embSim = i < docVecs.length ? cosineSimilarity(queryVec, docVecs[i]) : 0;
        var embNorm = (embSim + 1) / 2; // [-1, 1] → [0, 1]
        var hybrid = (1 - alpha) * bm25Norm + alpha * embNorm;
        reranked.push({
            filePath: c.filePath,
            line: c.line,
            snippet: c.snippet,
            score: c.score,
            matchType: c.matchType,
            _hybridScore: hybrid,
            _bm25Score: bm25Norm,
            _embScore: embSim
        });
    }
    reranked.sort(function (a, b) { return b._hybridScore - a._hybridScore; });
    return reranked;
}

// ═══ 暴露为全局对象 ═══
if (typeof window !== 'undefined') {
    window._qqqEmbedding = {
        embedText: embedText,
        embedBatch: embedBatch,
        cosineSimilarity: cosineSimilarity,
        rerankWithEmbedding: rerankWithEmbedding
    };
}
