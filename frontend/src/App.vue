<template>
  <div class="min-h-screen bg-slate-900 text-slate-200">
    <header class="border-b border-slate-700 px-6 py-4">
      <h1 class="text-2xl font-bold text-cyan-400">SQL 查询可视化与执行计划分析器</h1>
      <p class="text-sm text-slate-500 mt-1">SQL语法解析 · 执行计划树 · ER图 · 复杂度评分 · 优化建议</p>
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
          <div class="relative">
            <!-- 多段模式下的段落高亮层：位于文字下方，仅透出 mark 背景 -->
            <div v-if="store.isMulti" ref="mirrorRef" aria-hidden="true" class="sql-mirror">
              <span v-for="(p, i) in highlightPieces" :key="i">
                <mark v-if="p.seg !== null"
                  :class="['seg-mark',
                    p.seg === store.activeSegmentId
                      ? (store.segments[p.seg]?.error ? 'seg-mark-error' : 'seg-mark-active')
                      : 'seg-mark-idle']">{{ p.text }}</mark><template v-else>{{ p.text }}</template>
              </span>
            </div>
            <textarea ref="taRef" v-model="store.sql" rows="12"
              class="sql-editor w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-green-400 focus:outline-none focus:border-cyan-500 resize-none"
              :class="{ 'sql-editor-multi': store.isMulti }"
              @scroll="syncMirrorScroll" @click="onCursorMove" @keyup="onCursorMove"></textarea>
          </div>
          <div class="flex items-center justify-between mt-2">
            <span v-if="store.isMulti" class="text-xs text-slate-500">已识别 {{ store.segments.length }} 段语句，分号或空行分隔</span>
            <span v-else class="text-xs text-slate-500">单段语句分析</span>
          </div>
          <button @click="store.analyze" class="w-full mt-2 py-2 bg-cyan-600 hover:bg-cyan-500 rounded text-sm font-bold">分析查询</button>
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
        <!-- 多段：各段结论列表 -->
        <div v-if="store.isMulti" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">分段分析结果（共 {{ store.segments.length }} 段，点击查看执行计划）</h3>
          <div class="space-y-2">
            <div v-for="seg in store.segments" :key="seg.id" @click="onSelectSegment(seg.id)"
              :class="['cursor-pointer rounded border p-3 text-xs transition-all',
                seg.id === store.activeSegmentId
                  ? (seg.error ? 'border-red-500 bg-red-900/20' : 'border-cyan-500 bg-cyan-900/20')
                  : 'border-slate-700 hover:border-slate-500']">
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-bold text-slate-200">第 {{ seg.id + 1 }} 段</span>
                  <span v-if="seg.error" class="px-1.5 py-0.5 rounded bg-red-900/60 text-red-300 font-bold">不完整</span>
                  <template v-else-if="seg.parsed">
                    <span class="px-1.5 py-0.5 rounded bg-cyan-900/60 text-cyan-300 font-bold">{{ seg.parsed.type }}</span>
                    <span :class="['font-bold', complexityOf(seg.parsed.complexity).color]">
                      复杂度：{{ complexityOf(seg.parsed.complexity).label }}（{{ seg.parsed.complexity }}）
                    </span>
                  </template>
                </div>
                <div v-if="seg.parsed" class="text-slate-500 whitespace-nowrap">
                  JOIN {{ seg.parsed.joins.length }} · 预估 {{ seg.parsed.estimatedCost }}
                </div>
              </div>
              <div class="mt-1 font-mono text-slate-500 truncate">{{ firstLine(seg.range.text) }}</div>
              <!-- 涉及的表 -->
              <div v-if="seg.parsed" class="mt-2 flex items-center gap-1 flex-wrap">
                <span class="text-slate-500">涉及表：</span>
                <span v-for="t in seg.parsed.tables" :key="t" class="px-1.5 py-0.5 rounded bg-blue-900/40 border border-blue-800 text-blue-300">{{ t }}</span>
                <span v-if="!seg.parsed.tables.length" class="text-slate-600">无</span>
              </div>
              <!-- 不完整原因（仅标记这一段，不影响其它段） -->
              <div v-if="seg.error" class="mt-2 flex items-start gap-2 bg-red-900/30 border border-red-800 rounded p-2">
                <span class="text-red-400">✗</span><span class="text-red-300">{{ seg.error }}</span>
              </div>
              <!-- 优化建议 -->
              <template v-if="seg.id === store.activeSegmentId && seg.parsed">
                <div v-if="seg.parsed.suggestions.length" class="mt-2 space-y-1">
                  <div v-for="(s, i) in seg.parsed.suggestions" :key="i" class="flex items-start gap-2 bg-orange-900/30 border border-orange-700 rounded p-2">
                    <span class="text-orange-400">⚠</span><span class="text-orange-300">{{ s }}</span>
                  </div>
                </div>
                <div v-else class="mt-2 text-green-400 bg-green-900/20 border border-green-700 rounded p-2">✓ 未发现明显性能问题</div>
              </template>
            </div>
          </div>
        </div>

        <!-- 单段不完整 / 编辑器为空：仅给出原因 -->
        <div v-if="errorMessage" class="bg-slate-800 rounded-lg p-4 border border-red-700">
          <h3 class="text-sm font-bold text-red-400 mb-2">{{ store.analyzeError ? '无法分析' : (store.isMulti ? '该段语句不完整' : '语句不完整') }}</h3>
          <div class="text-sm text-red-300">{{ errorMessage }}</div>
          <div v-if="errorSnippet" class="mt-2 text-xs font-mono text-slate-500 bg-slate-900 rounded p-2">{{ errorSnippet }}</div>
        </div>

        <div v-if="store.parsed" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">查询解析结果<span v-if="store.isMulti" class="text-cyan-500">（第 {{ (store.activeSegmentId ?? 0) + 1 }} 段）</span></h3>
          <div class="grid grid-cols-4 gap-3 text-sm mb-4">
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">类型</div><div class="text-cyan-400 font-bold">{{ store.parsed.type }}</div></div>
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">复杂度</div><div class="font-bold" :class="store.complexityLabel.color">{{ store.complexityLabel.label }}</div></div>
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">JOIN数</div><div class="text-orange-400 font-bold">{{ store.parsed.joins.length }}</div></div>
            <div class="bg-slate-900 rounded p-2 text-center"><div class="text-xs text-slate-500 mb-1">预估行数</div><div class="text-purple-400 font-bold">{{ store.parsed.estimatedCost }}</div></div>
          </div>
          <div v-if="store.isMulti" class="mb-3 flex items-center gap-1 flex-wrap text-xs">
            <span class="text-slate-500">涉及表：</span>
            <span v-for="t in store.parsed.tables" :key="t" class="px-1.5 py-0.5 rounded bg-blue-900/40 border border-blue-800 text-blue-300">{{ t }}</span>
          </div>
          <div v-if="store.parsed.suggestions.length" class="space-y-1">
            <div class="text-xs text-slate-500 mb-1">优化建议</div>
            <div v-for="(s, i) in store.parsed.suggestions" :key="i" class="text-xs flex items-start gap-2 bg-orange-900/30 border border-orange-700 rounded p-2">
              <span class="text-orange-400">⚠</span><span class="text-orange-300">{{ s }}</span>
            </div>
          </div>
          <div v-else class="text-xs text-green-400 bg-green-900/20 border border-green-700 rounded p-2">✓ 未发现明显性能问题</div>
        </div>
        <div v-if="store.plan" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">执行计划树<span v-if="store.isMulti" class="text-cyan-500">（第 {{ (store.activeSegmentId ?? 0) + 1 }} 段）</span></h3>
          <div class="overflow-x-auto">
            <div class="font-mono text-xs text-slate-300 space-y-1">
              <PlanNode :node="store.plan" :depth="0" />
            </div>
          </div>
        </div>
        <div v-if="store.parsed" class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="text-sm font-bold text-slate-400 mb-3">涉及表与关联关系<span v-if="store.isMulti" class="text-cyan-500">（第 {{ (store.activeSegmentId ?? 0) + 1 }} 段）</span></h3>
          <canvas ref="erCanvasRef" class="w-full bg-slate-900 rounded" style="height:200px"></canvas>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, defineComponent, h, computed, nextTick } from 'vue'
import { useSQLStore, SQL_TEMPLATES, SCHEMA_TABLES, complexityInfo, type ParsedQuery } from './store/sql'

const store = useSQLStore()
const erCanvasRef = ref<HTMLCanvasElement | null>(null)
const mirrorRef = ref<HTMLDivElement | null>(null)
const taRef = ref<HTMLTextAreaElement | null>(null)

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

/** 高亮层分片：普通文本（分隔符/空白）与各段语句交替 */
const highlightPieces = computed(() => {
  const text = store.sql.replace(/\r\n?/g, '\n')
  const pieces: { text: string; seg: number | null }[] = []
  if (!store.isMulti) {
    pieces.push({ text, seg: null })
    return pieces
  }
  let pos = 0
  for (const s of store.segments) {
    if (s.range.start > pos) pieces.push({ text: text.slice(pos, s.range.start), seg: null })
    pieces.push({ text: text.slice(s.range.start, s.range.end), seg: s.id })
    pos = s.range.end
  }
  if (pos < text.length) pieces.push({ text: text.slice(pos), seg: null })
  return pieces
})

/** 当前应展示的错误信息（空编辑器 / 单段不完整 / 多段下选中段不完整） */
const errorMessage = computed(() => {
  if (store.analyzeError) return store.analyzeError
  return store.activeSegment?.error || null
})
const errorSnippet = computed(() => {
  if (store.analyzeError) return ''
  const text = store.activeSegment?.range.text || ''
  return text.length > 120 ? text.slice(0, 120) + ' …' : text
})

function complexityOf(c: number) {
  return complexityInfo(c)
}
function firstLine(text: string) {
  const line = text.split('\n')[0]
  return line.length > 80 ? line.slice(0, 80) + ' …' : line
}

/** 编辑器滚动时，高亮层跟随 */
function syncMirrorScroll() {
  const ta = taRef.value
  const mirror = mirrorRef.value
  if (!ta || !mirror) return
  mirror.scrollTop = ta.scrollTop
  mirror.scrollLeft = ta.scrollLeft
}

/** 在编辑器里点击/移动光标：同步选中光标所在段落 */
function onCursorMove() {
  const ta = taRef.value
  if (!ta) return
  store.syncSegmentAtCursor(ta.selectionStart ?? 0)
}

/** 从结果列表点选某段：切换执行计划并把编辑器滚动到该段位置 */
function onSelectSegment(id: number) {
  store.selectSegment(id)
  const ta = taRef.value
  const seg = store.segments.find(s => s.id === id)
  if (!ta || !seg) return
  const before = ta.value.slice(0, seg.range.start)
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 21
  const line = before.split('\n').length - 1
  const maxScroll = Math.max(0, ta.scrollHeight - ta.clientHeight)
  ta.scrollTop = Math.max(0, Math.min(maxScroll, line * lineHeight - ta.clientHeight / 2))
  syncMirrorScroll()
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

function redrawER() {
  nextTick(() => setTimeout(drawER, 60))
}

onMounted(() => {
  store.analyze()
  setTimeout(drawER, 200)
})
// 重新分析、切换段落、单/多段模式切换后都要重绘关系图
watch(() => [store.parsed, store.activeSegmentId, store.isMulti], () => {
  redrawER()
  // 进入多段模式时让高亮层与编辑器滚动位置对齐
  nextTick(syncMirrorScroll)
}, { deep: false })
</script>
