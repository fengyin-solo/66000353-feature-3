<template>
  <div class="min-h-screen bg-slate-900 text-slate-200">
    <header class="border-b border-slate-700 px-6 py-4">
      <h1 class="text-2xl font-bold text-cyan-400">SQL 查询可视化与执行计划分析器</h1>
      <p class="text-sm text-slate-500 mt-1">SQL语法解析 · 执行计划树 · ER图 · 复杂度评分 · 优化建议 · 多段批量分析（分号或空行分隔）</p>
    </header>
    <div class="flex flex-col lg:flex-row gap-4 p-4">
      <div class="lg:w-2/5 space-y-4">
        <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold text-slate-400">SQL 编辑器</h3>
            <div class="flex gap-2">
              <select @change="(e) => { store.sql = SQL_TEMPLATES[+(e.target as HTMLSelectElement).value].sql }" class="text-xs bg-slate-900 border border-slate-600 rounded px-2 py-1 text-slate-300">
                <option v-for="(t, i) in SQL_TEMPLATES" :key="i" :value="i">{{ t.name }}</option>
              </select>
            </div>
          </div>
          <div class="relative rounded focus-within:ring-1 focus-within:ring-cyan-500">
            <pre ref="highlightRef" class="sql-highlight-layer" aria-hidden="true"><code v-html="highlightHtml"></code></pre>
            <textarea ref="editorRef" v-model="store.sql" rows="12" spellcheck="false"
              class="sql-editor w-full bg-transparent text-green-400 resize-none focus:outline-none focus:border-cyan-500"
              @scroll="syncScroll"></textarea>
          </div>
          <button @click="runAnalyze" class="w-full mt-3 py-2 bg-cyan-600 hover:bg-cyan-500 rounded text-sm font-bold">分析查询</button>
          <p v-if="store.segments.length > 1" class="text-[11px] text-slate-500 mt-2">已识别 {{ store.segments.length }} 段语句 · 点击右侧段落卡片可在编辑器中定位该段</p>
        </div>
        <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">数据库 Schema</h3>
          <div class="space-y-2">
            <div v-for="t in SCHEMA_TABLES" :key="t.name" @click="store.activeSchema = store.activeSchema?.name === t.name ? null : t"
              :class="['cursor-pointer rounded border p-2 text-xs transition-all', store.activeSchema?.name === t.name ? 'border-cyan-500 bg-cyan-900/20' : 'border-slate-700 hover:border-slate-500']">
              <div class="flex justify-between items-center">
                <span class="font-bold text-slate-200">{{ t.name }}</span>
                <span class="text-slate-500">{{ t.rowCount.toLocaleString() }} 行</span>
              </div>
              <div v-if="store.activeSchema?.name === t.name" class="mt-2 space-y-0.5">
                <div v-for="c in t.columns" :key="c.name" class="flex gap-2">
                  <span :class="c.pk ? 'text-yellow-400' : c.fk ? 'text-blue-400' : 'text-slate-400'">{{ c.pk ? '🔑 ' : c.fk ? '🔗 ' : '  ' }}{{ c.name }}</span>
                  <span class="text-slate-600">{{ c.type }}</span>
                  <span v-if="c.fk" class="text-blue-600">→ {{ c.fk }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="lg:w-3/5 space-y-4">
        <!-- 多段：结论按段落列成列表 -->
        <div v-if="store.isMulti" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">段落分析结果（{{ store.segments.length }} 段）</h3>
          <div class="space-y-2">
            <div v-for="seg in store.segments" :key="seg.index"
              @click="focusSegment(seg)"
              :class="['cursor-pointer rounded border p-3 text-xs transition-all',
                seg.error ? 'border-red-700/60 bg-red-900/10 hover:bg-red-900/20'
                          : store.activeIndex === seg.index ? 'border-cyan-500 bg-cyan-900/20'
                          : 'border-slate-700 bg-slate-900/50 hover:border-slate-500']">
              <div class="flex items-center justify-between mb-2">
                <span class="font-bold" :class="seg.error ? 'text-red-400' : 'text-cyan-400'">第 {{ seg.index + 1 }} 段</span>
                <span v-if="seg.error" class="text-red-400 font-bold">语句不完整</span>
                <span v-else class="flex items-center gap-3">
                  <span class="text-slate-400">{{ seg.parsed!.type }}</span>
                  <span class="font-bold" :class="complexityOf(seg.parsed!.complexity).color">{{ complexityOf(seg.parsed!.complexity).label }}</span>
                </span>
              </div>
              <div class="font-mono text-[11px] text-slate-500 truncate mb-2">{{ seg.text.replace(/\s+/g, ' ') }}</div>
              <div v-if="seg.error" class="flex items-start gap-2 bg-red-900/30 border border-red-700 rounded p-2">
                <span class="text-red-400">✗</span><span class="text-red-300">{{ seg.error }}，该段已跳过，其余段落正常分析</span>
              </div>
              <template v-else>
                <div class="flex flex-wrap items-center gap-1.5 mb-2">
                  <span class="text-slate-500">涉及表：</span>
                  <span v-for="t in seg.parsed!.tables" :key="t" class="px-1.5 py-0.5 rounded bg-blue-900/40 border border-blue-800 text-blue-300">{{ t }}</span>
                  <span v-if="!seg.parsed!.tables.length" class="text-slate-600">无</span>
                  <span class="ml-auto text-slate-500">JOIN {{ seg.parsed!.joins.length }} · 预估 {{ seg.parsed!.estimatedCost }}</span>
                </div>
                <div v-if="seg.parsed!.suggestions.length" class="space-y-1">
                  <div v-for="(s, i) in seg.parsed!.suggestions" :key="i" class="flex items-start gap-2 bg-orange-900/30 border border-orange-700 rounded p-2">
                    <span class="text-orange-400">⚠</span><span class="text-orange-300">{{ s }}</span>
                  </div>
                </div>
                <div v-else class="text-green-400 bg-green-900/20 border border-green-700 rounded p-2">✓ 未发现明显性能问题</div>
              </template>
            </div>
          </div>
        </div>

        <!-- 单段：结论卡片与原来完全一致 -->
        <div v-else-if="store.parsed" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">查询解析结果</h3>
          <div class="grid grid-cols-4 gap-3 text-sm mb-4">
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">类型</div><div class="text-cyan-400 font-bold">{{ store.parsed.type }}</div></div>
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">复杂度</div><div class="font-bold" :class="store.complexityLabel.color">{{ store.complexityLabel.label }}</div></div>
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">JOIN数</div><div class="text-orange-400 font-bold">{{ store.parsed.joins.length }}</div></div>
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">预估行数</div><div class="text-purple-400 font-bold">{{ store.parsed.estimatedCost }}</div></div>
          </div>
          <div v-if="store.parsed.suggestions.length" class="space-y-1">
            <div class="text-xs text-slate-500 mb-1">优化建议</div>
            <div v-for="(s, i) in store.parsed.suggestions" :key="i" class="text-xs flex items-start gap-2 bg-orange-900/30 border border-orange-700 rounded p-2">
              <span class="text-orange-400">⚠</span><span class="text-orange-300">{{ s }}</span>
            </div>
          </div>
          <div v-else class="text-xs text-green-400 bg-green-900/20 border border-green-700 rounded p-2">✓ 未发现明显性能问题</div>
        </div>

        <!-- 单段但该段不完整 -->
        <div v-else-if="store.activeSegment" class="bg-slate-800 rounded-lg p-4 border border-red-700">
          <h3 class="text-sm font-bold text-red-400 mb-2">语句不完整，无法分析</h3>
          <div class="text-xs text-red-300 bg-red-900/30 border border-red-700 rounded p-2">{{ store.activeSegment.error }}</div>
        </div>

        <!-- 执行计划树：始终对应当前选中段落 -->
        <div v-if="store.plan" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">
            执行计划树<span v-if="store.isMulti" class="text-cyan-500">（第 {{ store.activeIndex + 1 }} 段）</span>
          </h3>
          <div class="overflow-x-auto">
            <div class="font-mono text-xs text-slate-300 space-y-1">
              <PlanNode :node="store.plan" :depth="0" />
            </div>
          </div>
        </div>

        <!-- 关系图：始终对应当前选中段落；单段时标题与原来一致 -->
        <div v-if="store.parsed" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">
            涉及表与关联关系<span v-if="store.isMulti" class="text-cyan-500">（第 {{ store.activeIndex + 1 }} 段）</span>
          </h3>
          <canvas ref="erCanvasRef" class="w-full bg-slate-900 rounded" style="height:200px"></canvas>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, defineComponent, h, nextTick } from 'vue'
import { useSQLStore, SQL_TEMPLATES, SCHEMA_TABLES, complexityOf, type SegmentResult } from './store/sql'

const store = useSQLStore()
const erCanvasRef = ref<HTMLCanvasElement | null>(null)
const editorRef = ref<HTMLTextAreaElement | null>(null)
const highlightRef = ref<HTMLElement | null>(null)

const PlanNode = defineComponent({
  props: { node: Object, depth: Number },
  setup(props) {
    return () => {
      if (!props.node) return null
      const n = props.node as any
      const indent = '  '.repeat(props.depth || 0)
      const opColor = n.operation.includes('Scan') ? '#22c55e' : n.operation.includes('Join') ? '#f97316' : n.operation.includes('Sort') ? '#8b5cf6' : '#06b6d4'
      return h('div', [
        h('div', { style: `padding-left: ${(props.depth || 0) * 20}px` }, [
          h('span', { style: 'color: #475569' }, indent.replace(/\s\s/g, '│ ').replace(/│ $/, '└─')),
          h('span', { style: `color: ${opColor}; font-weight: bold` }, n.operation),
          n.table ? h('span', { style: 'color: #94a3b8' }, ` on ${n.table}`) : null,
          n.index ? h('span', { style: 'color: #eab308' }, ` [${n.index}]`) : null,
          h('span', { style: 'color: #64748b' }, ` cost=${n.cost.toFixed(1)} rows=${n.rows}`),
        ]),
        ...(n.children || []).map((child: any) => h(PlanNode, { node: child, depth: (props.depth || 0) + 1 }))
      ])
    }
  }
})

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 编辑区高亮覆盖层内容：把当前选中段落包进高亮 span，其余文本原样渲染 */
const highlightHtml = ref('')
function renderHighlight() {
  const range = store.activeRange
  if (!range) {
    highlightHtml.value = escapeHtml(store.sql) + '\n'
    return
  }
  const { start, end } = range
  highlightHtml.value =
    escapeHtml(store.sql.slice(0, start)) +
    '<span class="sql-segment-active">' + escapeHtml(store.sql.slice(start, end)) + '</span>' +
    escapeHtml(store.sql.slice(end)) + '\n'
}

function syncScroll() {
  const ta = editorRef.value, hl = highlightRef.value
  if (!ta || !hl) return
  hl.scrollTop = ta.scrollTop
  hl.scrollLeft = ta.scrollLeft
}

/** 点选结果段落：切换结论/计划/关系图，并在编辑器中高亮、选中、滚动到该段 */
async function focusSegment(seg: SegmentResult) {
  store.selectSegment(seg.index)
  renderHighlight()
  await nextTick()
  const ta = editorRef.value
  if (ta) {
    ta.focus()
    ta.setSelectionRange(seg.start, seg.end)
    // 估算行高并把目标段滚动到可视区域
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20
    const line = store.sql.slice(0, seg.start).split('\n').length - 1
    ta.scrollTop = Math.max(0, line * lineHeight - ta.clientHeight / 3)
    syncScroll()
  }
}

/** 重新分析后强制恢复高亮（即便选中段落序号没有变化） */
async function runAnalyze() {
  store.analyze()
  renderHighlight()
  await nextTick()
  syncScroll()
}

function drawER() {
  const canvas = erCanvasRef.value
  if (!canvas || !store.parsed) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const tables = store.parsed.tables
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  canvas.width = canvas.clientWidth
  canvas.height = 200
  const W = canvas.width, H = 200
  const spacing = W / (tables.length + 1)
  const positions: Record<string, { x: number; y: number }> = {}
  tables.forEach((t, i) => { positions[t] = { x: spacing * (i + 1), y: H / 2 } })

  // Draw joins
  store.parsed.joins.forEach(j => {
    const src = positions[tables[0]]
    const dst = positions[j.table]
    if (!src || !dst) return
    ctx.beginPath()
    ctx.moveTo(src.x, src.y)
    ctx.lineTo(dst.x, dst.y)
    ctx.strokeStyle = '#f97316'
    ctx.lineWidth = 2
    ctx.setLineDash([4, 4])
    ctx.stroke()
    ctx.setLineDash([])
    const mx = (src.x + dst.x) / 2, my = (src.y + dst.y) / 2
    ctx.fillStyle = '#f97316'
    ctx.font = '10px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(j.type, mx, my - 5)
  })

  // Draw table boxes
  tables.forEach((t, i) => {
    const pos = positions[t]
    if (!pos) return
    const x = pos.x, y = pos.y
    ctx.fillStyle = '#1e293b'
    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.roundRect(x - 50, y - 30, 100, 60, 6)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#06b6d4'
    ctx.font = 'bold 13px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(t, x, y - 10)
    const schema = SCHEMA_TABLES.find(s => s.name === t)
    if (schema) {
      ctx.fillStyle = '#64748b'
      ctx.font = '10px monospace'
      ctx.fillText(schema.rowCount.toLocaleString() + ' rows', x, y + 10)
    }
  })
}

onMounted(() => { store.analyze(); renderHighlight(); setTimeout(drawER, 200) })
// 解析结果变化（重新分析 / 切换段落）后重绘关系图
watch(() => store.parsed, () => setTimeout(drawER, 100), { deep: true })
// 切换选中段落时刷新高亮
watch(() => store.activeIndex, () => renderHighlight())
// 编辑内容后（与分析快照不一致）取消段落高亮，避免区间错位
watch(() => store.sql, () => {
  if (store.analyzedSql !== store.sql) {
    highlightHtml.value = escapeHtml(store.sql) + '\n'
    requestAnimationFrame(syncScroll)
  }
})
</script>

<style scoped>
/* 编辑器与高亮层共享完全一致的排版，保证逐字符对齐 */
.sql-editor,
.sql-highlight-layer {
  margin: 0;
  padding: 0.5rem calc(0.75rem + 8px) 0.5rem 0.75rem;
  border: 1px solid #475569;
  border-radius: 0.25rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.875rem;
  line-height: 1.4;
  letter-spacing: 0;
  tab-size: 4;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: break-word;
  word-break: normal;
  box-sizing: border-box;
  /* 两层预留同样的滚动条宽度，保证换行位置逐字符对齐 */
  scrollbar-width: thin;
  scrollbar-color: #475569 transparent;
}

.sql-editor {
  position: relative;
  z-index: 2;
  width: 100%;
  overflow: auto;
  caret-color: #4ade80;
}

.sql-highlight-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  color: transparent;
  background: transparent;
  overflow: hidden;
}

.sql-segment-active {
  background: rgba(34, 211, 238, 0.18);
  box-shadow: inset 0 0 0 1px rgba(34, 211, 238, 0.55);
  border-radius: 2px;
}
</style>
