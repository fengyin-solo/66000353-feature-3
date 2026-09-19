import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface SQLTable {
  name: string
  columns: { name: string; type: string; pk?: boolean; fk?: string }[]
  rowCount: number
}

export interface QueryPlan {
  operation: string
  table?: string
  cost: number
  rows: number
  children: QueryPlan[]
  index?: string
  filter?: string
}

export interface ParsedQuery {
  type: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'UNKNOWN'
  tables: string[]
  columns: string[]
  joins: { type: string; table: string; condition: string }[]
  whereConditions: string[]
  orderBy: string[]
  groupBy: string[]
  limit?: number
  complexity: number
  suggestions: string[]
  estimatedCost: number
}

/** 一段语句在编辑器原文中的字符区间 */
export interface SegmentRange {
  start: number
  end: number
  text: string
}

export interface SegmentResult {
  id: number
  range: SegmentRange
  error?: string
  parsed?: ParsedQuery
  plan?: QueryPlan
}

const SCHEMA: SQLTable[] = [
  { name: 'users', rowCount: 50000, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'username', type: 'VARCHAR(50)' },
    { name: 'email', type: 'VARCHAR(100)' }, { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'status', type: 'ENUM' }
  ]},
  { name: 'orders', rowCount: 200000, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'user_id', type: 'INT', fk: 'users.id' },
    { name: 'product_id', type: 'INT', fk: 'products.id' }, { name: 'amount', type: 'DECIMAL' },
    { name: 'status', type: 'VARCHAR(20)' }, { name: 'created_at', type: 'TIMESTAMP' }
  ]},
  { name: 'products', rowCount: 10000, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'name', type: 'VARCHAR(200)' },
    { name: 'price', type: 'DECIMAL' }, { name: 'category_id', type: 'INT', fk: 'categories.id' },
    { name: 'stock', type: 'INT' }
  ]},
  { name: 'categories', rowCount: 100, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'name', type: 'VARCHAR(50)' },
    { name: 'parent_id', type: 'INT' }
  ]},
]

/** 引号对（单/双引号、反引号）匹配表，用于扫描时跳过字符串字面量 */
const QUOTE_CLOSE: Record<string, string> = { "'": "'", '"': '"', '`': '`' }

/**
 * 把编辑器内容拆成多段语句。
 * 分隔规则（两种可混用）：
 *   1. 顶层（括号深度为 0、字符串之外）的分号；
 *   2. 顶层的空行（连续两个换行，中间只允许空白字符）——
 *      括号/字符串内部的空行不算分隔符，避免拆散子查询。
 */
export function splitStatements(input: string): SegmentRange[] {
  const sql = input.replace(/\r\n?/g, '\n')
  const segments: SegmentRange[] = []
  let start = 0
  let depth = 0
  let quote: string | null = null

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]

    if (quote) {
      if (ch === '\\' && i + 1 < sql.length) { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = QUOTE_CLOSE[ch]; continue }
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue }
    if (depth !== 0) continue

    if (ch === ';') {
      addSegment(segments, sql, start, i)
      start = i + 1
      continue
    }
    // 当前位置是一个“空行”：空白行之后紧跟换行（首段前的空行跳过）
    if (ch === '\n' && i > start) {
      let j = i - 1
      while (j >= start && (sql[j] === ' ' || sql[j] === '\t')) j--
      if (j >= start && sql[j] === '\n') {
        addSegment(segments, sql, start, i)
        start = i + 1
      }
    }
  }
  addSegment(segments, sql, start, sql.length)
  return segments
}

/** 截取 [s, e) 区间并按空白 trim，空段忽略；偏移基于已归一化换行的文本 */
function addSegment(out: SegmentRange[], sql: string, s: number, e: number) {
  let b = s
  let t = e
  while (b < t && /\s/.test(sql[b])) b++
  while (t > b && /\s/.test(sql[t - 1])) t--
  if (b >= t) return
  out.push({ start: b, end: t, text: sql.slice(b, t) })
}

/**
 * 粗粒度完整性检查，返回无法分析的原因；完整则返回 null。
 * 只检查明显的不完整写法，避免误报。
 */
function findIncompleteness(sql: string): string | null {
  const trimmed = sql.trim()
  if (!trimmed) return '内容为空'

  // 1. 未闭合的字符串
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      if (ch === '\\' && i + 1 < sql.length) { i++; continue }
      if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
    }
  }
  if (quote) return `存在未闭合的 ${quote === '`' ? '反引号' : '引号'}（${quote}），字符串没有写完`

  // 2. 括号不配对
  let depth = 0
  let activeQuote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (activeQuote) {
      if (ch === '\\' && i + 1 < sql.length) { i++; continue }
      if (ch === activeQuote) activeQuote = null
    } else if (ch === "'" || ch === '"' || ch === '`') {
      activeQuote = ch
    } else if (ch === '(') depth++
    else if (ch === ')') depth--
    if (depth < 0) return '存在多余的右括号 “)”'
  }
  if (depth > 0) return `存在 ${depth} 个未闭合的左括号 “(”，语句没有写完`

  const up = trimmed.toUpperCase()

  // 3. 无法识别的语句类型
  const type = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE'].find(k => up.startsWith(k))
  if (!type) {
    return '未以 SELECT / INSERT / UPDATE / DELETE / CREATE 开头，无法识别的语句'
  }

  // 4. SELECT 缺少 FROM
  if (type === 'SELECT' && !/\bFROM\b/.test(up)) {
    return 'SELECT 语句缺少 FROM 子句，未指定查询的表'
  }
  // SELECT 后直接跟 FROM（列清单为空）
  if (type === 'SELECT' && /^SELECT\s+FROM\b/.test(up)) {
    return 'SELECT 与 FROM 之间没有任何列'
  }
  // 5. INSERT 缺少目标表 / VALUES
  if (type === 'INSERT') {
    if (!/\bINTO\s+[a-zA-Z_`"\[]\w*/.test(up)) return 'INSERT 语句缺少 INTO 或目标表名'
    if (!/\bVALUES\b/.test(up) && !/\bSELECT\b/.test(up) && !/\bSET\b/.test(up)) {
      return 'INSERT 语句缺少 VALUES（或 SELECT / SET）数据来源'
    }
  }
  // 6. UPDATE 缺少 SET
  if (type === 'UPDATE' && !/\bSET\b/.test(up)) {
    return 'UPDATE 语句缺少 SET 子句'
  }
  // 7. 以运算符 / 逗号结尾
  if (/[+\-*/%,=(<>]$/.test(trimmed)) return `语句以 “${trimmed.slice(-1)}” 结尾，表达式不完整`
  // 8. 以子句关键字结尾
  if (/\b(WHERE|AND|OR|ON|SET|VALUES|SELECT|FROM|JOIN|INNER|LEFT|RIGHT|OUTER|FULL|CROSS|GROUP|ORDER|BY|HAVING|LIMIT|INTO|IN|NOT|LIKE|BETWEEN)$/.test(up)) {
    const kw = up.trim().split(/\s+/).pop()
    return `语句以关键字 ${kw} 结尾，后面缺少内容`
  }
  // 9. 连续的子句关键字（如 WHERE AND、FROM WHERE）
  if (/\b(FROM|WHERE|ON|AND|OR|BY)\s+(WHERE|GROUP|ORDER|LIMIT|HAVING|AND|OR)\b/.test(up)) {
    const m = trimmed.match(/(?:FROM|WHERE|ON|AND|OR|BY)\s+(?:WHERE|GROUP|ORDER|LIMIT|HAVING|AND|OR)/i)
    return `关键字衔接不完整：${m ? m[0] : ''}`
  }
  // 10. JOIN 缺少 ON（CROSS / NATURAL JOIN 不需要）
  let joinCount = 0
  const joinWord = /\bJOIN\b/gi
  let jm: RegExpExecArray | null
  while ((jm = joinWord.exec(trimmed)) !== null) {
    const before = trimmed.slice(0, jm.index).trim().toUpperCase()
    const prevWord = before.split(/\s+/).pop() || ''
    if (prevWord !== 'CROSS' && prevWord !== 'NATURAL') joinCount++
  }
  const onCount = (trimmed.match(/\bON\b/gi) || []).length
  if (joinCount > onCount) return '存在 JOIN 缺少对应的 ON 连接条件'

  return null
}

function parseSQL(sql: string): ParsedQuery {
  const up = sql.toUpperCase().trim()
  const type = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE'].find(t => up.startsWith(t)) as ParsedQuery['type'] || 'UNKNOWN'
  const tables = Array.from(sql.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_]\w*)/gi)).map(m => m[1].toLowerCase())
  const columns = type === 'SELECT' ? Array.from(sql.matchAll(/SELECT\s+([\s\S]*?)\s+FROM/gi))[0]?.[1]?.split(',').map((s: string) => s.trim()) || [] : []
  const joins = Array.from(sql.matchAll(/(?:(LEFT|RIGHT|INNER|OUTER|CROSS|FULL)\s+)?JOIN\s+([a-zA-Z_]\w*)[\s\S]*?(?=\s+(?:LEFT\s+|RIGHT\s+|INNER\s+|OUTER\s+|CROSS\s+|FULL\s+)?JOIN\b|\s+WHERE\b|\s+GROUP\b|\s+ORDER\b|\s+LIMIT\b|\s+HAVING\b|$)/gi))
    .map(m => {
      const onMatch = m[0].match(/\bON\s+([\s\S]+)$/i)
      return { type: (m[1] || 'INNER').trim(), table: m[2], condition: (onMatch?.[1] || '').trim() }
    })
  const whereMatch = sql.match(/WHERE\s+([\s\S]*?)(?:GROUP|ORDER|LIMIT|$)/i)
  const whereConditions = whereMatch ? whereMatch[1].split(/\s+AND\s+|\s+OR\s+/i).map(s => s.trim()).filter(Boolean) : []
  const orderBy = Array.from(sql.matchAll(/ORDER\s+BY\s+([\s\S]*?)(?:LIMIT|$)/gi))[0]?.[1]?.split(',').map((s: string) => s.trim()) || []
  const groupBy = Array.from(sql.matchAll(/GROUP\s+BY\s+([\s\S]*?)(?:HAVING|ORDER|LIMIT|$)/gi))[0]?.[1]?.split(',').map((s: string) => s.trim()) || []
  const limitMatch = sql.match(/LIMIT\s+(\d+)/i)
  const limit = limitMatch ? parseInt(limitMatch[1]) : undefined

  const complexity = tables.length + joins.length * 2 + whereConditions.length + orderBy.length + (sql.includes('DISTINCT') ? 3 : 0) + (sql.includes('HAVING') ? 2 : 0)
  const estimatedCost = tables.reduce((sum, t) => { const tbl = SCHEMA.find(s => s.name === t); return sum + (tbl?.rowCount || 1000) }, 0) * (joins.length + 1) / (limit || 100)

  const suggestions: string[] = []
  if (joins.length > 3) suggestions.push('连接表过多（>3），考虑分解查询')
  if (!whereConditions.length && type === 'SELECT') suggestions.push('无 WHERE 条件，将扫描全表')
  if (sql.includes('SELECT *')) suggestions.push('避免 SELECT *，明确指定列名')
  if (sql.toUpperCase().includes("LIKE '%")) suggestions.push("前缀通配符 LIKE '%...' 无法使用索引")
  if (!limit && type === 'SELECT') suggestions.push('建议添加 LIMIT 限制结果集大小')

  return { type, tables, columns, joins, whereConditions, orderBy, groupBy, limit, complexity, suggestions, estimatedCost: Math.round(estimatedCost) }
}

function buildPlan(parsed: ParsedQuery): QueryPlan {
  if (parsed.tables.length === 0) return { operation: 'EMPTY', cost: 0, rows: 0, children: [] }
  const tableScans: QueryPlan[] = parsed.tables.map(t => {
    const tbl = SCHEMA.find(s => s.name === t)
    return { operation: parsed.whereConditions.length > 0 ? 'Index Scan' : 'Seq Scan', table: t, cost: (tbl?.rowCount || 1000) * 0.01, rows: Math.round((tbl?.rowCount || 1000) * (parsed.whereConditions.length > 0 ? 0.1 : 1)), children: [], index: parsed.whereConditions.length > 0 ? 'idx_' + t + '_id' : undefined }
  })
  if (tableScans.length === 1) {
    const root: QueryPlan = { operation: 'Sort', cost: tableScans[0].cost * 1.2, rows: tableScans[0].rows, children: [tableScans[0]] }
    return root
  }
  const join: QueryPlan = { operation: 'Hash Join', cost: tableScans.reduce((s, n) => s + n.cost, 0) * 1.5, rows: Math.round(tableScans[0].rows * 0.5), children: tableScans, filter: parsed.joins[0]?.condition }
  return { operation: parsed.orderBy.length ? 'Sort' : 'Result', cost: join.cost * 1.1, rows: join.rows, children: [join] }
}

export function complexityInfo(complexity: number) {
  if (complexity <= 2) return { label: '简单', color: 'text-green-400' }
  if (complexity <= 5) return { label: '中等', color: 'text-yellow-400' }
  if (complexity <= 8) return { label: '复杂', color: 'text-orange-400' }
  return { label: '非常复杂', color: 'text-red-400' }
}

export const SQL_TEMPLATES = [
  { name: '基础查询', sql: `SELECT id, username, email
FROM users
WHERE status = 'active'
LIMIT 100;` },
  { name: '多表JOIN', sql: `SELECT u.username, o.id AS order_id, p.name AS product, o.amount
FROM users u
INNER JOIN orders o ON u.id = o.user_id
INNER JOIN products p ON o.product_id = p.id
WHERE o.status = 'completed'
ORDER BY o.created_at DESC
LIMIT 50;` },
  { name: '聚合分析', sql: `SELECT c.name AS category, COUNT(o.id) AS order_count, SUM(o.amount) AS revenue, AVG(o.amount) AS avg_amount
FROM categories c
LEFT JOIN products p ON c.id = p.category_id
LEFT JOIN orders o ON p.id = o.product_id
GROUP BY c.id, c.name
HAVING COUNT(o.id) > 10
ORDER BY revenue DESC;` },
  { name: '子查询', sql: `SELECT username, email
FROM users
WHERE id IN (
  SELECT DISTINCT user_id
  FROM orders
  WHERE amount > 1000
  AND created_at >= '2024-01-01'
)
ORDER BY username;` },
  { name: '全表扫描', sql: `SELECT *
FROM orders
WHERE YEAR(created_at) = 2024;` },
  { name: '多段（分号）', sql: `SELECT id, username FROM users WHERE status = 'active' LIMIT 20;

SELECT o.id, o.amount
FROM orders o
INNER JOIN users u ON o.user_id = u.id
WHERE o.status = 'completed'
ORDER BY o.created_at DESC
LIMIT 50;

UPDATE users SET status = 'inactive' WHERE last_login_at < '2025-01-01';` },
  { name: '多段（空行+分号）', sql: `SELECT * FROM products WHERE stock = 0

SELECT c.name, COUNT(p.id) AS product_count
FROM categories c
LEFT JOIN products p ON c.id = p.category_id
GROUP BY c.id, c.name;

SELECT username FROM users WHERE` },
]

export const SCHEMA_TABLES = SCHEMA

export const useSQLStore = defineStore('sql', () => {
  const sql = ref(SQL_TEMPLATES[0].sql)
  const parsed = ref<ParsedQuery | null>(null)
  const plan = ref<QueryPlan | null>(null)
  const activeSchema = ref<SQLTable | null>(null)
  /** 各段分析结果；为空表示尚未分析 */
  const segments = ref<SegmentResult[]>([])
  /** 当前点选查看的段落 id */
  const activeSegmentId = ref<number | null>(null)
  /** 整段文本无法分析时（例如编辑器为空）的提示 */
  const analyzeError = ref<string | null>(null)

  /** 本次分析是否为多段（>1 段）；单段时所有呈现保持原样 */
  const isMulti = computed(() => segments.value.length > 1)

  const activeSegment = computed(() =>
    segments.value.find(s => s.id === activeSegmentId.value) || null
  )

  function analyze() {
    // 统一换行符，保证段落区间偏移与编辑器光标位置一致（处理 Windows 粘贴的 CRLF）
    sql.value = sql.value.replace(/\r\n?/g, '\n')
    const ranges = splitStatements(sql.value)
    analyzeError.value = null

    if (ranges.length === 0) {
      segments.value = []
      activeSegmentId.value = null
      parsed.value = null
      plan.value = null
      analyzeError.value = '编辑器内容为空，请输入 SQL 语句'
      return
    }

    const results: SegmentResult[] = ranges.map((range, id) => {
      const reason = findIncompleteness(range.text)
      if (reason) return { id, range, error: reason }
      const p = parseSQL(range.text)
      return { id, range, parsed: p, plan: buildPlan(p) }
    })
    segments.value = results
    activeSegmentId.value = 0

    if (results.length === 1) {
      // 单段：结论与关系图的呈现与原来完全一致
      parsed.value = results[0].parsed || null
      plan.value = results[0].plan || null
    } else {
      // 多段：默认展示第一段（可能是错误段）
      parsed.value = results[0].parsed || null
      plan.value = results[0].plan || null
    }
  }

  /** 点选结果列表中的某一段 */
  function selectSegment(id: number) {
    const seg = segments.value.find(s => s.id === id)
    if (!seg) return
    activeSegmentId.value = id
    parsed.value = seg.parsed || null
    plan.value = seg.plan || null
  }

  /**
   * 编辑器内光标移动时调用：光标落在哪一段就同步选中该段，
   * 实现“在编辑区点选段落 -> 结果列表与执行计划联动”。
   */
  function syncSegmentAtCursor(offset: number) {
    if (!isMulti.value) return
    const found = segments.value.find(s => offset >= s.range.start && offset <= s.range.end)
    if (found && found.id !== activeSegmentId.value) selectSegment(found.id)
  }

  const complexityLabel = computed(() => complexityInfo(parsed.value?.complexity || 0))

  return {
    sql, parsed, plan, activeSchema, complexityLabel, analyze,
    segments, activeSegmentId, activeSegment, isMulti, analyzeError,
    selectSegment, syncSegmentAtCursor,
  }
})
