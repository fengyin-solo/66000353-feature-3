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

export interface SegmentResult {
  /** 该段在原始编辑文本中的起止下标（end 不含） */
  start: number
  end: number
  text: string
  /** 段落在原文中的序号（从 1 开始） */
  index: number
  parsed?: ParsedQuery
  plan?: QueryPlan
  error?: string
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

/**
 * 将编辑区文本按“分号”或“空行（连续两个及以上换行）”切分为多段。
 * 分号位于字符串字面量或 -- 行注释中时不作为分隔符。
 * 返回每段的文本及其在原文中的精确下标，便于编辑区同步高亮。
 */
export function splitSQLSegments(sql: string): { text: string; start: number; end: number }[] {
  const segments: { text: string; start: number; end: number }[] = []
  let start = 0
  let quote: string | null = null
  let i = 0
  const pushFrom = (end: number) => {
    const text = sql.slice(start, end)
    if (text.trim()) segments.push({ text: text.trim(), start, end })
  }
  while (i < sql.length) {
    const ch = sql[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (quote === "'" && ch === '\\' && i + 1 < sql.length) i++ // 转义字符
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i++; continue }
    // -- 行注释：直接跳到行尾，注释中的 ; 不参与切分
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl
      continue
    }
    if (ch === ';') {
      pushFrom(i)
      start = i + 1
      i++
      continue
    }
    if (ch === '\n') {
      // 向后探测：下一行为“空行”（空串或仅含空格/制表位）则按空行分隔，
      // 并连续吞掉后续所有空行
      let k = i + 1
      while (k < sql.length && (sql[k] === ' ' || sql[k] === '\t')) k++
      if (sql[k] === '\n') {
        let j = k
        while (j < sql.length) {
          if (sql[j] !== '\n') {
            let m = j
            while (m < sql.length && (sql[m] === ' ' || sql[m] === '\t')) m++
            if (sql[m] !== '\n') break // 碰到了有内容的行
            j = m
          }
          j++ // 跳过换行符
        }
        pushFrom(i)
        start = j
        i = j
        continue
      }
    }
    i++
  }
  pushFrom(sql.length)
  return segments
}

/**
 * 对单段语句做完整性检查，返回无法分析的原因；完整则返回 null。
 */
export function validateSegment(text: string): string | null {
  // 未闭合的字符串字面量
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\' && quote === "'" && i + 1 < text.length) { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
  }
  if (quote) return `字符串字面量缺少结束的 ${quote}`

  // 括号不配对
  const stack: string[] = []
  for (const ch of text) {
    if (ch === '(') stack.push(')')
    else if (ch === '[') stack.push(']')
    else if (ch === ')' || ch === ']') {
      if (stack.pop() !== ch) return '括号不配对'
    }
  }
  if (stack.length) return '括号未闭合'

  const up = text.toUpperCase().trim()
  const type = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE'].find(t => up.startsWith(t))
  if (!type) return '无法识别的语句类型（应以 SELECT/INSERT/UPDATE/DELETE/CREATE 开头）'

  // 以关键字或运算符结尾，说明语句被截断
  const trailingMatch = up.match(/([A-Z<>!=+-]+)\s*$/)
  if (trailingMatch) {
    const last = trailingMatch[1]
    const KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'AND', 'OR', 'GROUP', 'BY', 'ORDER',
      'HAVING', 'LIMIT', 'INTO', 'VALUES', 'SET', 'IN', 'LIKE', 'AS', 'INNER', 'LEFT', 'RIGHT',
      'OUTER', 'FULL', 'CROSS', 'NOT', 'NULL', 'IS', 'ASC', 'DESC', 'UNION', 'INSERT', 'UPDATE',
      'DELETE', 'CREATE', 'TABLE', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN']
    if (KEYWORDS.includes(last)) return `语句不完整：结尾的 ${last} 后缺少内容`
    if (['=', '<', '>', '!', '+', '-', ','].includes(last)) return '语句不完整：结尾的运算符后缺少内容'
  }

  if (type === 'INSERT' && !/\bINTO\b/i.test(text)) return 'INSERT 语句缺少 INTO 子句'
  if (type === 'UPDATE' && !/\bSET\b/i.test(text)) return 'UPDATE 语句缺少 SET 子句'
  if (type === 'SELECT' && /\bFROM\b/i.test(text) && !/\bFROM\s+[a-zA-Z_`"\[]/.test(text)) {
    return 'FROM 关键字后缺少表名'
  }
  if (/\bJOIN\b/i.test(text) && !/\bJOIN\s+[a-zA-Z_`"\[]/.test(text)) return 'JOIN 关键字后缺少表名'
  return null
}

function parseSQL(sql: string): ParsedQuery {
  const up = sql.toUpperCase().trim()
  const type = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE'].find(t => up.startsWith(t)) as ParsedQuery['type'] || 'UNKNOWN'
  const tables = Array.from(sql.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_]\w*)/gi)).map(m => m[1].toLowerCase())
  const columns = type === 'SELECT' ? Array.from(sql.matchAll(/SELECT\s+([\s\S]*?)\s+FROM/gi))[0]?.[1]?.split(',').map((s: string) => s.trim()) || [] : []
  const joins = Array.from(sql.matchAll(/(LEFT|RIGHT|INNER|OUTER|CROSS|FULL)?\s*JOIN\s+([a-zA-Z_]\w*)\s+ON\s+([^JOIN|WHERE|GROUP|ORDER|LIMIT]+)/gi)).map(m => ({ type: (m[1] || 'INNER').trim(), table: m[2], condition: m[3].trim() }))
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

export function complexityOf(complexity?: number) {
  const c = complexity ?? 0
  if (c <= 2) return { label: '简单', color: 'text-green-400', border: 'border-green-700' }
  if (c <= 5) return { label: '中等', color: 'text-yellow-400', border: 'border-yellow-700' }
  if (c <= 8) return { label: '复杂', color: 'text-orange-400', border: 'border-orange-700' }
  return { label: '非常复杂', color: 'text-red-400', border: 'border-red-700' }
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
  { name: '多段批量分析', sql: `SELECT id, username
FROM users
WHERE status = 'active'
LIMIT 100;

SELECT u.username, o.amount
FROM users u
INNER JOIN orders o ON u.id = o.user_id
WHERE o.status = 'completed'
ORDER BY o.created_at DESC
LIMIT 50;

SELECT category_id, COUNT(*) AS cnt
FROM products
GROUP BY category_id

UPDATE orders
SET status = 'shipped'
WHERE` },
]

export const SCHEMA_TABLES = SCHEMA

export const useSQLStore = defineStore('sql', () => {
  const sql = ref(SQL_TEMPLATES[0].sql)
  /** 最近一次点击“分析查询”时的文本快照，用于校验高亮区间是否仍然有效 */
  const analyzedSql = ref('')
  const segments = ref<SegmentResult[]>([])
  const activeIndex = ref(0)
  const activeSchema = ref<SQLTable | null>(null)

  function analyze() {
    analyzedSql.value = sql.value
    segments.value = splitSQLSegments(sql.value).map((seg, i) => {
      const result: SegmentResult = { start: seg.start, end: seg.end, text: seg.text, index: i }
      const error = validateSegment(seg.text)
      if (error) {
        result.error = error
      } else {
        result.parsed = parseSQL(seg.text)
        result.plan = buildPlan(result.parsed)
      }
      return result
    })
    activeIndex.value = 0
  }

  const isMulti = computed(() => segments.value.length > 1)
  const activeSegment = computed(() => segments.value[activeIndex.value] || null)
  /** 兼容单段视图：始终指向当前选中段落的解析结果 */
  const parsed = computed(() => activeSegment.value?.parsed ?? null)
  const plan = computed(() => activeSegment.value?.plan ?? null)

  const complexityLabel = computed(() => complexityOf(parsed.value?.complexity))

  function selectSegment(i: number) {
    if (i >= 0 && i < segments.value.length) activeIndex.value = i
  }

  /** 当前选中段落在最近分析快照中的区间；编辑后文本已变化时不做高亮，避免错位 */
  const activeRange = computed<{ start: number; end: number } | null>(() => {
    const seg = activeSegment.value
    if (!seg || analyzedSql.value !== sql.value) return null
    return { start: seg.start, end: seg.end }
  })

  return {
    sql, analyzedSql, segments, activeIndex, activeSegment, activeRange,
    isMulti, parsed, plan, activeSchema, complexityLabel, analyze, selectSegment,
  }
})
