<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalMask from '@/components/ModalMask.vue';
import { appendOpToLatestLeaf, deleteLeafAt, deleteSummary, editLeafAt, editPlan, editSummary } from '@/memory/apply';
import { apiSettings } from '@/api/settings';
import { batchBackfill, batchState, cancelBatchBackfill, engineState, resummarizeNow, summarizeFloor, summarizeSelected } from '@/memory/engine';
import { refreshInjection, selectViewNodes, type ViewNode } from '@/memory/inject';
import { compactTimeLabel, formatRange, splitTimeLabel } from '@/memory/timeTag';
import { relativeTimeLabel, weekdayLabel } from '@/memory/timeRel';
import { derivedMeta, memory, recomputeDerived } from '@/memory/store';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { computed, nextTick, onMounted, onUnmounted, provide, ref } from 'vue';
import SummaryNode from './SummaryNode.vue';
import { SUMMARY_CTX, type SummaryRow } from './ctx';

// 打开摘要页时强制重算一次派生:未摘要楼层等派生缓存只在特定事件刷新,
// 边聊边攒的新 AI 楼可能没触发刷新,进页先对齐一次,避免列表漏楼。
onMounted(() => recomputeDerived());

// 切聊天:重置临时视图态(展开/搜索/选择),避免上个聊天的残留跨聊天带过来。
const resetViewStates = () => {
  expanded.value = new Set();
  searchQuery.value = '';
  searchOpen.value = false;
  exitSelectMode();
};
let offChatChanged: (() => void) | null = null;
onMounted(() => {
  const ctx = getContext();
  const es = ctx?.eventSource;
  const et = ctx?.eventTypes;
  if (es && et?.CHAT_CHANGED) {
    es.on(et.CHAT_CHANGED, resetViewStates);
    offChatChanged = () => es.off?.(et.CHAT_CHANGED, resetViewStates);
  }
});
onUnmounted(() => offChatChanged?.());

// 触屏判定:用于跳过弹窗自动聚焦(移动端自动聚焦会弹出输入法挡住界面)。
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

/* ============ Huyền niệm簿(顶部)============ */
const newKind = ref<'plan' | 'suspense'>('plan');
const newContent = ref('');
const newTargetTime = ref(''); // 手动ThêmKế hoạch时的Tùy chọn目标Thời gian(故事内Thời gian)
// 手动Thêm是低频操作:用弹窗承载,平时只露一个小「+」按钮,不占版面。
const composerOpen = ref(false);
const contentInput = ref<HTMLTextAreaElement | null>(null);
function openComposer() {
  if (!hasLeaf.value) return;
  newKind.value = 'plan';
  newContent.value = '';
  newTargetTime.value = '';
  composerOpen.value = true;
  // 仅在非触屏自动聚焦:移动端自动聚焦会立刻弹出输入法,挡住弹窗、体验差。
  if (!isTouch) void nextTick(() => contentInput.value?.focus());
}
function closeComposer() {
  composerOpen.value = false;
}
// Kế hoạch/Huyền niệm只展示「进行中」。点Xóa即Xóa bỏ——不再Có「了结/已了结」概念。
const openPlans = computed(() => memory.plans.filter(p => p.status === 'open'));
const hasLeaf = computed(() => derivedMeta.hasLeaf);

/* —— Huyền niệm簿折叠 ——
 * Kế hoạch/Huyền niệm攒多了,整段很长,要滚很久才到下方的摘要。标题行兼作折叠开关。
 * 折叠态是本机视图偏好(同 activePage 那类临时导航态),走 localStorage、不进 apiSettings——
 * 跨设备同步它没意义,且不该污染真·设置。 */
const SUSPENSE_COLLAPSE_KEY = 'bbs.ui.suspenseCollapsed.v1';
const suspenseCollapsed = ref(loadSuspenseCollapsed());
function loadSuspenseCollapsed(): boolean {
  try {
    return localStorage.getItem(SUSPENSE_COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}
function toggleSuspense() {
  suspenseCollapsed.value = !suspenseCollapsed.value;
  try {
    localStorage.setItem(SUSPENSE_COLLAPSE_KEY, suspenseCollapsed.value ? '1' : '0');
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}
// 没CóKế hoạch/Huyền niệm就Không có可折叠:不显示箭头,也强制展开(避免删空后卡在收拢的空态)
const suspenseFoldable = computed(() => openPlans.value.length > 0);
const suspenseShown = computed(() => !suspenseCollapsed.value || !suspenseFoldable.value);

// 叶子 id → 创建楼层。Kế hoạch id 形如 `plan:${叶子id}#${序号}`,由此反查创建该Kế hoạch/Huyền niệm
// 时所在楼层(与摘要列表的 #楼层 同源)。手动Thêm的Kế hoạch挂在最新叶子上,显示其楼层。
const leafFloor = computed(() => {
  const m = new Map<string, number>();
  for (const l of derivedMeta.leaves) m.set(l.id, l.msgIndex);
  return m;
});
function planFloor(planId: string): number | undefined {
  const leafId = planId.replace(/^plan:/, '').replace(/#\d+$/, '');
  return leafFloor.value.get(leafId);
}

function addPlan() {
  const content = newContent.value.trim();
  if (!content) return;
  // 创建Thời gian用当前已知故事Thời gian(没Có就留空);目标Thời gian仅Kế hoạch可填,用户填了才带上
  const createdTime = memory.state.time?.trim() || undefined;
  const targetTime = newKind.value === 'plan' ? newTargetTime.value.trim() || undefined : undefined;
  if (!appendOpToLatestLeaf({ plans: { add: [{ kind: newKind.value, content, createdTime, targetTime }] } })) return;
  newContent.value = '';
  newTargetTime.value = '';
  composerOpen.value = false;
}
function removePlan(id: string) {
  appendOpToLatestLeaf({ plans: { remove: [id] } });
}

/* —— Chỉnh sửaKế hoạch/Huyền niệm(弹窗)—— */
const editingPlan = ref<{ id: string; kind: 'plan' | 'suspense'; content: string; createdTime: string; targetTime: string } | null>(null);
function openPlanEdit(p: { id: string; kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string }) {
  editingPlan.value = {
    id: p.id,
    kind: p.kind,
    content: p.content,
    createdTime: p.createdTime ?? '',
    targetTime: p.targetTime ?? '',
  };
}
function cancelPlanEdit() {
  editingPlan.value = null;
}
function savePlanEdit() {
  const e = editingPlan.value;
  if (!e || !e.content.trim()) return;
  editPlan(e.id, {
    content: e.content,
    createdTime: e.createdTime,
    // 目标Thời gian仅Kế hoạchCó意义;Huyền niệm保持空
    targetTime: e.kind === 'plan' ? e.targetTime : '',
  });
  refreshInjection();
  editingPlan.value = null;
}

/* ============ 未摘要楼层 ============
 * derivedMeta.pendingFloors = AI 楼且Không cóCó效叶子,由旧到新;此处倒序展示(新楼在前)。 */
const pendingFloors = computed(() => [...derivedMeta.pendingFloors].sort((a, b) => b - a));
const summarizingFloor = ref<number | null>(null);
async function summarizeOne(floor: number) {
  if (engineState.running || summarizingFloor.value !== null) return;
  summarizingFloor.value = floor;
  try {
    await summarizeFloor(floor);
  } finally {
    summarizingFloor.value = null;
  }
}

/* ============ Bổ sung tóm tắt hàng loạt ============
 * 把所Có未摘楼层按Nội dung量分块、逐块串行补摘:省 token(固定上下文按块分摊)+ 减请求数。
 * 先弹确认(显示待摘楼数),执行中显示进度 + 可Hủy bỏ(块边界生效)。
 * 运行状态读 engine 的 batchState 单例(非组件本地 ref):关掉柏宝书窗口再重开,
 * 进度条与Hủy bỏ按钮能恢复——因为任务在 engine 里继续跑,关窗不Hủy bỏ。 */
const batchConfirmOpen = ref(false);

function openBatchConfirm() {
  if (engineState.running || !pendingFloors.value.length) return;
  batchConfirmOpen.value = true;
}
function runBatchBackfill() {
  batchConfirmOpen.value = false;
  if (engineState.running) return;
  // 不 await:任务在 engine 里跑,状态走 batchState 单例;UI 只读它,不依赖本函数停留
  void batchBackfill({
    // 由旧到新补;pendingFloors 是倒序展示用,这里传升序更稳(引擎内部也会再过滤排序)
    floors: [...derivedMeta.pendingFloors].sort((a, b) => a - b),
  });
}

/* ============ 立即总结 ============
 * 手动触发一次「检测是否达阈Giá trị → 达到就总结(可连锁多层)」。结果用一句临时提示反馈。 */
const resummaryRunning = ref(false);
const resummaryHint = ref('');
let resummaryHintTimer: ReturnType<typeof setTimeout> | null = null;

// 总结节奏:实际约每「Số tin nhắn AI gần đây giữ lại + Số tin nhắn AI mỗi lần tổng kết」楼总结一次——
// 最近 keepRecent 条发全文不摘,更早的摘成叶子,叶子攒够 leafBatchThreshold 条压一次总结。
// 阈Giá trịĐóng(<2)时不显示节奏句。
const resummaryEvery = computed(() => (Math.max(0, apiSettings.keepRecent) + apiSettings.leafBatchThreshold) * 2);
const showCadence = computed(() => apiSettings.leafBatchThreshold >= 2);

async function doResummarize() {
  if (resummaryRunning.value || engineState.running) return;
  resummaryRunning.value = true;
  resummaryHint.value = '';
  try {
    const made = await resummarizeNow();
    // Có报错优先显示错误(如未指派总结Kênh);否则按生成条数给反馈
    if (engineState.lastError) {
      resummaryHint.value = '';
    } else if (made > 0) {
      resummaryHint.value = `Đã tạo ${made} tổng kết`;
    } else {
      // 未达阈Giá trị:补一句动态节奏,告诉用户大概每多少楼总结一次
      const cadence = showCadence.value ? `, khoảng ${resummaryEvery.value} tầng tổng kết 1 lần` : '';
      resummaryHint.value = `Hiện chưa đạt ngưỡng tổng kết tóm tắt${cadence}`;
    }
  } finally {
    resummaryRunning.value = false;
    if (resummaryHintTimer) clearTimeout(resummaryHintTimer);
    if (resummaryHint.value) resummaryHintTimer = setTimeout(() => (resummaryHint.value = ''), 4000);
  }
}

/* ============ 摘要列表(下方)============ */
/**
 * 平铺展示行:搜索(全森林命中平铺)与选择(根 + 复选框)两视图用。
 * Mặc định视图(根 + 逐层展开)改由递归组件 SummaryNode 直接渲染,不经此结构。
 */
interface DisplayRow extends SummaryRow {
  isChild: boolean; // 搜索命中的深层(已压缩)节点:只读,不给Chỉnh sửa/XóaKhóa
}

/**
 * 完整森林视图(byId):所Có**Có效**叶子(stale=false)+ 全部压缩节点。
 * ⚠️ 必须走 derivedMeta 而非直接扫 chat:chat 非 reactive,UI 要变更须经 derivedMeta。
 * 展开(取 comp 的 childIds)与搜索(遍历全部节点,含已压缩的深层)都从这里取。
 */
const byId = computed<Map<string, ViewNode>>(() => {
  const m = new Map<string, ViewNode>();
  for (const l of derivedMeta.leaves) {
    if (l.stale) continue;
    m.set(l.id, {
      id: l.id, kind: 'leaf', level: 0, text: l.text,
      timeStart: l.timeStart, timeEnd: l.timeEnd, timeLabel: l.timeLabel,
      createdAt: l.createdAt, childIds: [], msgIndex: l.msgIndex, active: l.active,
    });
  }
  for (const s of memory.summaries) {
    m.set(s.id, {
      id: s.id, kind: 'comp', level: s.level, text: s.text,
      timeStart: s.timeStart, timeEnd: s.timeEnd, timeLabel: s.timeLabel,
      createdAt: s.createdAt, childIds: s.childIds ?? [], msgIndex: -1, active: false,
    });
  }
  return m;
});

/** 递归解析某节点覆盖的叶子楼层集合(comp 取全部后代Có效叶子;失效 child 取不到则跳过)。 */
function nodeFloors(n: ViewNode, map: Map<string, ViewNode>): [number, number] {
  const acc: number[] = [];
  const seen = new Set<string>();
  const walk = (x: ViewNode): void => {
    if (seen.has(x.id)) return;
    seen.add(x.id);
    if (x.kind === 'leaf') { acc.push(x.msgIndex); return; }
    for (const cid of x.childIds) {
      const c = map.get(cid);
      if (c) walk(c);
    }
  };
  walk(n);
  return acc.length ? [Math.min(...acc), Math.max(...acc)] : [-1, -1];
}

/** ViewNode → 展示行核心字段(供卡片渲染) */
function toRow(n: ViewNode, map: Map<string, ViewNode>): SummaryRow {
  const [lo, hi] = nodeFloors(n, map);
  return {
    key: `${n.kind}:${n.id}`,
    id: n.id,
    kind: n.kind,
    level: n.level,
    text: n.text,
    timeStart: n.timeStart,
    timeEnd: n.timeEnd,
    timeLabel: n.timeLabel,
    floorLo: lo,
    floorHi: hi,
    msgIndex: n.kind === 'leaf' ? n.msgIndex : undefined,
    stale: false,
  };
}

/** 根节点(倒序:楼层越靠后越在上面),供Mặc định视图与选择视图。 */
const rootNodes = computed<ViewNode[]>(() => {
  const map = byId.value;
  const referenced = new Set<string>();
  for (const s of memory.summaries) for (const c of s.childIds ?? []) referenced.add(c);
  const roots = [...map.values()].filter(n => !referenced.has(n.id));
  // 含失效后代的压缩节点不完整 → selectViewNodes 自动降级,只拆受影响那条链(旁支完好的整条保留)
  const chosen = selectViewNodes({ byId: map, roots }, () => true);
  return chosen.sort((a, b) => nodeFloors(b, map)[1] - nodeFloors(a, map)[1]);
});

/* ---- 视图态:展开 / 搜索 / 选择(三者互斥,均为临时 UI 态,不持久化) ---- */
const expanded = ref<Set<string>>(new Set()); // 已展开的 comp id
const searchQuery = ref('');
// 搜索框Mặc định收起,点工具行放大镜才展开——平时不占版面。收起即清空搜索词。
const searchOpen = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);
const selectMode = ref(false);
const selectedIds = ref<Set<string>>(new Set());

const searching = computed(() => searchQuery.value.trim().length > 0);

function openSearch() {
  searchOpen.value = true;
  // 非触屏自动聚焦;触屏不聚焦避免立刻弹输入法(与ThêmKế hoạch弹窗同款取舍)
  if (!isTouch) void nextTick(() => searchInput.value?.focus());
}
function closeSearch() {
  searchOpen.value = false;
  searchQuery.value = '';
}
function toggleSearch() {
  if (searchOpen.value) closeSearch();
  else openSearch();
}

function toggleExpand(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

/** 搜索视图:遍历**全森林**(含已压缩深层节点),命中平铺、按楼层倒序。 */
function buildSearchRows(): DisplayRow[] {
  const map = byId.value;
  const q = searchQuery.value.trim();
  const qLower = q.toLowerCase();
  // 楼层查询:纯数字 / #数字 → 命中覆盖该楼的节点
  const floorNum = /^#?\d+$/.test(q) ? Number(q.replace(/^#/, '')) : null;
  const rootIdSet = new Set(rootNodes.value.map(n => n.id));

  const rows: DisplayRow[] = [];
  for (const n of map.values()) {
    const base = toRow(n, map);
    let hit = false;
    if (n.text && n.text.toLowerCase().includes(qLower)) hit = true;
    if (!hit && floorNum !== null && base.floorLo >= 0 && floorNum >= base.floorLo && floorNum <= base.floorHi) hit = true;
    if (!hit) {
      const t = base.timeStart || base.timeEnd ? formatRange(base.timeStart, base.timeEnd) : (base.timeLabel ? compactTimeLabel(base.timeLabel) : '');
      if (t && t.toLowerCase().includes(qLower)) hit = true;
    }
    if (!hit) continue;
    // 命中的根行可Chỉnh sửa/Xóa;已被压缩的深层节点只读(展开语义一致,避免误删祖先链)
    const isRoot = rootIdSet.has(n.id);
    rows.push({ ...base, isChild: !isRoot });
  }
  return rows.sort((a, b) => b.floorHi - a.floorHi);
}

/** 平铺视图行:搜索命中平铺 / 选择态的根;Mặc định视图不走这里(由 SummaryNode 递归渲染)。 */
const visibleRows = computed<DisplayRow[]>(() => {
  if (searching.value) return buildSearchRows();
  const map = byId.value;
  // 选择模式:仅根,倒序,带复选框
  return rootNodes.value.map(n => ({ ...toRow(n, map), isChild: false }));
});

/** 搜索命中文本切片:把 text 按命中词切成 [{t, hit}] 片段,模板用 span 渲染(不走 v-html,防 XSS)。 */
function highlightParts(text: string): Array<{ t: string; hit: boolean }> {
  const q = searchQuery.value.trim();
  if (!q || !searching.value) return [{ t: text, hit: false }];
  const lower = text.toLowerCase();
  const qLower = q.toLowerCase();
  const parts: Array<{ t: string; hit: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(qLower, i);
    if (idx < 0) { parts.push({ t: text.slice(i), hit: false }); break; }
    if (idx > i) parts.push({ t: text.slice(i, idx), hit: false });
    parts.push({ t: text.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  return parts.length ? parts : [{ t: text, hit: false }];
}

/* ---- 选择模式:进出、勾选、连续性约束、Gộp ---- */
function enterSelectMode() {
  selectMode.value = true;
  selectedIds.value = new Set();
  expanded.value = new Set(); // 折叠所Có展开,只操作根
}
function exitSelectMode() {
  selectMode.value = false;
  selectedIds.value = new Set();
}
function toggleSelect(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

/** 选中项在根序列(倒序)里的位置索引,升序排列 */
const selectedRootIndexes = computed<number[]>(() => {
  const roots = rootNodes.value;
  const idxs: number[] = [];
  roots.forEach((n, i) => { if (selectedIds.value.has(n.id)) idxs.push(i); });
  return idxs;
});
/** 是否可Gộp:选中 ≥2 且在根序列里连续(Không có跳选) */
const canMerge = computed(() => {
  const idxs = selectedRootIndexes.value;
  if (idxs.length < 2) return false;
  for (let i = 1; i < idxs.length; i++) if (idxs[i] !== idxs[i - 1] + 1) return false;
  return true;
});
/** 选中项覆盖的楼层范围与将生成的层级(供操作条展示) */
const selectionSummary = computed(() => {
  const map = byId.value;
  const picked = rootNodes.value.filter(n => selectedIds.value.has(n.id));
  if (!picked.length) return { count: 0, floorLo: -1, floorHi: -1, level: 1 };
  let lo = Infinity, hi = -Infinity, maxLevel = 0;
  for (const n of picked) {
    const [a, b] = nodeFloors(n, map);
    if (a >= 0) lo = Math.min(lo, a);
    if (b >= 0) hi = Math.max(hi, b);
    maxLevel = Math.max(maxLevel, n.level);
  }
  return {
    count: picked.length,
    floorLo: lo === Infinity ? -1 : lo,
    floorHi: hi === -Infinity ? -1 : hi,
    level: maxLevel + 1,
  };
});

const mergeConfirmOpen = ref(false);
const merging = ref(false);
function openMergeConfirm() {
  if (!canMerge.value || merging.value || engineState.running) return;
  mergeConfirmOpen.value = true;
}
async function runMerge() {
  mergeConfirmOpen.value = false;
  if (!canMerge.value || merging.value) return;
  // 按根序列升序(即楼层旧→新)传给引擎;引擎内部还会再排一次
  const idxs = [...selectedRootIndexes.value].sort((a, b) => a - b);
  const ids = idxs.map(i => rootNodes.value[i].id);
  merging.value = true;
  try {
    const res = await summarizeSelected(ids);
    if (res.made > 0) {
      exitSelectMode();
    } else if (res.error) {
      // 失败时保留选择。早退分支(未生效/正忙/不连续等)不走引擎的 try/catch,
      // 不会写 engineState.lastError,故这里主动弹 toast,避免「Không có事发生、Không có报错」。
      toast(res.error, 'warning');
    }
  } finally {
    merging.value = false;
  }
}

/** 行的展示Thời gian:新数据用 timeStart/timeEnd 合成并压缩;旧数据回退到已固化的 timeLabel(也压缩一次) */
function rowTime(r: SummaryRow): string {
  if (r.timeStart || r.timeEnd) return formatRange(r.timeStart, r.timeEnd);
  return r.timeLabel ? compactTimeLabel(r.timeLabel) : '';
}
/** 行的相对Thời gian前缀(如「昨天·周三」):仅叶子(单楼摘要)显示;总结跨多楼、相对Thời gianKhông có意义,返回空串 */
function rowRelative(r: SummaryRow): string {
  if (r.kind !== 'leaf') return '';
  const event = r.timeEnd || r.timeStart || (r.timeLabel ? splitTimeLabel(r.timeLabel).end : '') || '';
  // 周几并入相对前缀(标准公历带年份才Có);与注入端口径一致
  return [relativeTimeLabel(event, derivedMeta.latestStoryTime), weekdayLabel(event)].filter(Boolean).join('·');
}

// 当前Thời gian:优先读正文标签实时算出的「故事内最新Thời gian」(不受最新楼是否已摘影响);
// 取不到再回退派生的 state.time(老数据/Không có标签场景)。修掉「最新楼未摘时显示旧Thời gian」的问题。
const currentTime = computed(() => derivedMeta.latestStoryTime || memory.state.time);
/** 当前Thời gian的周几(仅标准公历带年份才Có);展示用 */
const currentWeekday = computed(() => weekdayLabel(currentTime.value));

function levelLabel(level: number): string {
  if (level === 0) return 'Tóm tắt';
  return `Tổng kết L${level}`;
}
/** 楼层范围标签:单楼 #5,跨楼 #0 - #10 */
function floorLabel(r: SummaryRow): string {
  if (r.floorLo < 0) return '—';
  return r.floorLo === r.floorHi ? `#${r.floorLo}` : `#${r.floorLo} - #${r.floorHi}`;
}

function onDelete(r: SummaryRow) {
  if (r.kind === 'leaf') {
    if (!confirm('Xóa tóm tắt này? Các thay đổi vật phẩm, kế hoạch, thời gian/địa điểm sẽ được tính lại theo các tóm tắt còn lại (có thể hoàn tác); tổng kết chứa nó cũng sẽ bị xóa. Tầng gốc vẫn giữ ẩn.')) return;
    if (typeof r.msgIndex === 'number') deleteLeafAt(r.msgIndex);
  } else {
    if (!confirm('Xóa tổng kết này? Các tóm tắt tầng dưới được nó thu thập sẽ mở rộng lại, vật phẩm/kế hoạch không bị ảnh hưởng.')) return;
    deleteSummary(r.id);
  }
  refreshInjection();
}

/* ============ Chỉnh sửa弹窗 ============
 * 叶子:可改「故事内Thời gian」+ 正文;总结:只压文本,故只改正文。 */
type Editing =
  | { kind: 'leaf'; msgIndex: number; text: string; timeStart: string; timeEnd: string }
  | { kind: 'comp'; compId: string; level: number; text: string };
const editing = ref<Editing | null>(null);

function openEdit(r: SummaryRow) {
  if (r.kind === 'leaf' && typeof r.msgIndex === 'number') {
    // 旧数据Không có timeStart/timeEnd 时,从已固化的 timeLabel 拆出起止填入
    const fb = !r.timeStart && !r.timeEnd ? splitTimeLabel(r.timeLabel) : {};
    editing.value = {
      kind: 'leaf',
      msgIndex: r.msgIndex,
      text: r.text,
      timeStart: r.timeStart ?? fb.start ?? '',
      timeEnd: r.timeEnd ?? fb.end ?? '',
    };
  } else if (r.kind === 'comp') {
    editing.value = { kind: 'comp', compId: r.id, level: r.level, text: r.text };
  }
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  const e = editing.value;
  if (!e) return;
  if (e.kind === 'leaf') editLeafAt(e.msgIndex, e.text, e.timeStart, e.timeEnd);
  else editSummary(e.compId, e.text);
  refreshInjection();
  editing.value = null;
}

// 注入递归卡片(SummaryNode)所需的状态、helper 与动作,免逐层 props 透传
provide(SUMMARY_CTX, {
  byId, expanded, selectMode, searching, selectedIds,
  toggleExpand, toggleSelect, openEdit, onDelete,
  nodeFloors, toRow, levelLabel, floorLabel, rowTime, rowRelative, highlightParts,
});
</script>

<template>
  <section class="bbs-page">
    <!-- ===== Huyền niệm簿 ===== -->
    <!-- 标题行兼作折叠开关:点标题/箭头收展;右侧「+」独立,stop 冒泡避免误触折叠 -->
    <div class="bbs-section-head">
      <button
        class="bbs-fold-head"
        type="button"
        :class="{ 'is-static': !suspenseFoldable }"
        :disabled="!suspenseFoldable"
        :aria-expanded="suspenseShown"
        :title="suspenseFoldable ? (suspenseShown ? 'Thu gọn sổ huyền niệm' : 'Mở rộng sổ huyền niệm') : ''"
        @click="toggleSuspense"
      >
        <Icon v-if="suspenseFoldable" name="chevron" class="bbs-fold-caret" :class="{ 'is-collapsed': !suspenseShown }" />
        <h2 class="bbs-title bbs-title-sub">Sổ huyền niệm</h2>
        <span v-if="suspenseFoldable" class="bbs-fold-count">Tổng {{ openPlans.length }} mục</span>
      </button>
      <button
        class="bbs-add-mini"
        type="button"
        :disabled="!hasLeaf"
        :title="hasLeaf ? 'Thêm kế hoạch / huyền niệm thủ công' : 'Cần có tóm tắt trước để thêm thủ công'"
        @click="openComposer"
      >
        <Icon name="plus" />
      </button>
    </div>

    <!-- grid 1fr↔0fr 收展:高度自适应、Không có需写死 max-height;reduced-motion 下瞬切(见样式) -->
    <div class="bbs-fold-wrap" :class="{ 'is-collapsed': !suspenseShown }">
      <div class="bbs-fold-inner">
        <div v-if="openPlans.length" class="bbs-plan-group">
          <div v-for="p in openPlans" :key="p.id" class="bbs-plan">
            <div class="bbs-plan-head">
              <span class="bbs-plan-kind" :class="p.kind">{{ p.kind === 'suspense' ? 'Huyền niệm' : 'Kế hoạch' }}</span>
              <span v-if="planFloor(p.id) !== undefined" class="bbs-plan-floor">#{{ planFloor(p.id) }}</span>
              <span class="bbs-plan-acts">
                <button class="bbs-plan-act" type="button" title="Chỉnh sửa" @click="openPlanEdit(p)"><Icon name="edit" /></button>
                <button class="bbs-plan-act bbs-plan-del" type="button" title="Xóa" @click="removePlan(p.id)"><Icon name="close" /></button>
              </span>
            </div>
            <p class="bbs-plan-content">{{ p.content }}</p>
            <!-- 故事内Thời gian:立于(创建Thời gian)/ 目标(目标Thời gian),任一存在才显示 -->
            <div v-if="p.createdTime || p.targetTime" class="bbs-plan-times">
              <span v-if="p.createdTime" class="bbs-plan-time">Tạo lúc {{ p.createdTime }}</span>
              <span v-if="p.targetTime" class="bbs-plan-time bbs-plan-time-target">Mục tiêu {{ p.targetTime }}</span>
            </div>
          </div>
        </div>
        <p v-else class="bbs-plan-empty">Chưa có kế hoạch hay huyền niệm nào. Sẽ tự động bắt lấy khi tóm tắt, cũng có thể thêm thủ công.</p>
      </div>
    </div>

    <!-- 分章分隔:两侧细线 + 居中金色菱形(古籍分章鱼尾标记),比普通 hr 更明确地隔开两区 -->
    <div class="bbs-divider" role="separator" aria-hidden="true">
      <span class="bbs-divider-mark"></span>
    </div>

    <!-- ===== 摘要 ===== -->
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">Tóm tắt</h2>
      <div class="bbs-summary-tools">
        <!-- 搜索:点放大镜展开搜索框(平时收起不占版面);已展开则收起并清空 -->
        <button
          v-if="!selectMode"
          class="bbs-add-mini"
          type="button"
          :class="{ 'is-on': searchOpen }"
          :disabled="!rootNodes.length"
          :title="searchOpen ? 'Thu gọn tìm kiếm' : 'Tìm kiếm tóm tắt'"
          @click="toggleSearch"
        >
          <Icon name="search" />
        </button>
        <!-- 选择模式:进/出。选择态下换成「Hoàn tất」,并隐藏立即总结(避免与Gộp撞车) -->
        <!-- 窄屏收成纯图标(隐藏 .bbs-btn-label),与左侧放大镜同权重,不喧宾夺主 -->
        <button
          v-if="!selectMode"
          class="bbs-btn bbs-btn-sm"
          type="button"
          :disabled="!rootNodes.length || searching"
          title="Chọn nhiều tóm tắt liên tiếp, gộp thủ công thành một tổng kết"
          @click="enterSelectMode"
        >
          <Icon name="checklist" /><span class="bbs-btn-label">Chọn nhiều</span>
        </button>
        <button
          v-else
          class="bbs-btn bbs-btn-sm"
          type="button"
          title="Thoát chọn nhiều"
          @click="exitSelectMode"
        >
          <Icon name="close" /><span class="bbs-btn-label">Hoàn tất</span>
        </button>
        <button
          v-if="!selectMode"
          class="bbs-btn bbs-btn-sm bbs-resummary-btn"
          type="button"
          :disabled="resummaryRunning || engineState.running"
          title="Kiểm tra tóm tắt đạt ngưỡng chưa, nếu đạt sẽ tiến hành tổng kết ngay"
          @click="doResummarize"
        >
          <span v-if="resummaryRunning" class="bbs-pending-spin"></span>
          <Icon v-else name="bolt" />
          <span class="bbs-btn-label">Tổng kết ngay</span>
        </button>
      </div>
    </div>
    <p v-if="resummaryHint" class="bbs-resummary-hint">{{ resummaryHint }}</p>

    <!-- 搜索框:点工具行放大镜才展开(选择模式下不显示,两态互斥)。搜全森林(含已压缩的深层节点) -->
    <div v-if="!selectMode && searchOpen && rootNodes.length" class="bbs-search">
      <Icon name="search" class="bbs-search-icon" />
      <input
        ref="searchInput"
        v-model="searchQuery"
        class="bbs-input bbs-search-input"
        type="text"
        placeholder="Tìm nội dung tóm tắt / thời gian, hoặc nhập #số_tầng"
        @keydown.esc="closeSearch"
      />
      <button class="bbs-search-clear" type="button" :title="searching ? 'Xóa trống' : 'Thu gọn tìm kiếm'" @click="searching ? (searchQuery = '') : closeSearch()">
        <Icon name="close" />
      </button>
    </div>

    <!-- 未摘要楼层:只列楼层号,点一下单独补摘那一楼;楼层多时可「Bổ sung tóm tắt hàng loạt」 -->
    <div v-if="pendingFloors.length" class="bbs-pending">
      <div class="bbs-pending-head">
        <span class="bbs-pending-label" :data-count="pendingFloors.length">
          <Icon name="summary" />Tầng chưa tóm tắt
        </span>
        <!-- Bổ sung tóm tắt hàng loạt:把全部未摘楼层分块串行补完(省 token、减请求);批量进行中显示进度+Hủy bỏ -->
        <button
          v-if="!batchState.running"
          class="bbs-btn bbs-btn-sm bbs-batch-btn"
          type="button"
          :disabled="engineState.running || summarizingFloor !== null"
          title="Bổ sung toàn bộ tầng chưa tóm tắt theo từng lô một lần (tiết kiệm token và nhanh hơn làm từng tầng)"
          @click="openBatchConfirm"
        >
          <Icon name="plans" />Bổ sung tóm tắt hàng loạt
        </button>
        <span v-else class="bbs-batch-progress">
          <span class="bbs-pending-spin"></span>
          Đang tóm tắt bù {{ batchState.done }}/{{ batchState.total }}
          <button class="bbs-batch-cancel" type="button" :disabled="batchState.cancelRequested" @click="cancelBatchBackfill">
            {{ batchState.cancelRequested ? 'Đang dừng...' : 'Hủy bỏ' }}
          </button>
        </span>
      </div>
      <div class="bbs-pending-chips">
        <button
          v-for="f in pendingFloors"
          :key="f"
          class="bbs-pending-chip"
          type="button"
          :disabled="engineState.running || summarizingFloor !== null || batchState.running"
          :title="`Tạo tóm tắt cho tầng #${f}`"
          @click="summarizeOne(f)"
        >
          <span v-if="summarizingFloor === f" class="bbs-pending-spin"></span>
          <template v-else>#{{ f }}</template>
        </button>
      </div>
    </div>

    <!-- Bổ sung tóm tắt hàng loạt确认弹窗 -->
    <ConfirmDialog
      v-model:open="batchConfirmOpen"
      title="Bổ sung tóm tắt hàng loạt"
      confirmText="Bắt đầu"
      @confirm="runBatchBackfill"
    >
      Tổng cộng {{ pendingFloors.length }} tầng chưa tóm tắt, sẽ chia lô theo lượng nội dung để tóm tắt bù tuần tự (tiết kiệm token và nhanh hơn tóm tắt từng tầng).
      Có thể hủy bỏ bất cứ lúc nào trong quá trình (sẽ dừng lại sau khi hoàn tất lô hiện tại). Tiếp tục?
    </ConfirmDialog>

    <!-- 当前状态 -->
    <div v-if="currentTime || memory.state.location" class="bbs-state">
      <div v-if="currentTime" class="bbs-state-item">
        <span class="bbs-state-key">Thời gian</span>
        <span class="bbs-state-val">{{ currentTime }}<template v-if="currentWeekday"> ({{ currentWeekday }})</template></span>
      </div>
      <div v-if="memory.state.location" class="bbs-state-item">
        <span class="bbs-state-key">Địa điểm</span>
        <span class="bbs-state-val">{{ memory.state.location }}</span>
      </div>
    </div>

    <p v-if="engineState.lastError" class="bbs-error">{{ engineState.lastError }}</p>

    <!-- Mặc định视图:根倒序,逐层展开由 SummaryNode 递归承载(grid 高度过渡,不脱流、Không có闪烁) -->
    <div v-if="!searching && !selectMode && rootNodes.length" class="bbs-summary-list">
      <SummaryNode v-for="n in rootNodes" :key="`${n.kind}:${n.id}`" :node="n" :depth="0" />
    </div>

    <!-- 搜索 / 选择视图:平铺列表(Không có逐层展开)。搜索命中含已压缩的深层节点 -->
    <div
      v-else-if="visibleRows.length"
      class="bbs-summary-list"
      :class="{ 'is-selecting': selectMode }"
    >
      <article
        v-for="r in visibleRows"
        :key="r.key"
        class="bbs-summary-card"
        :class="{ 'is-deep': r.level > 0, 'is-stale': r.stale, 'is-child': r.isChild, 'is-selected': selectMode && selectedIds.has(r.id) }"
      >
        <!-- 选择模式:复选框(仅根行);点整卡也可勾选 -->
        <label v-if="selectMode" class="bbs-summary-check">
          <input
            class="bbs-checkbox"
            type="checkbox"
            :checked="selectedIds.has(r.id)"
            @change="toggleSelect(r.id)"
          />
        </label>
        <div class="bbs-summary-main">
          <header class="bbs-summary-meta">
            <!-- 总结:层级标签 + 范围药丸 + 相对Thời gian(留题首行)+ 绝对Thời gian(窄屏换行) -->
            <template v-if="r.kind === 'comp'">
              <span class="bbs-summary-badge">{{ levelLabel(r.level) }}</span>
              <span class="bbs-summary-loc">{{ floorLabel(r) }}</span>
              <span v-if="rowRelative(r)" class="bbs-summary-rel">({{ rowRelative(r) }})</span>
              <span v-if="rowTime(r)" class="bbs-summary-time">{{ rowTime(r) }}</span>
            </template>
            <!-- 摘要:相对Thời gian + 楼层号都做成等高小标签(盒子居中,免去 CJK 基线下沉),绝对Thời gian作题首文本(窄屏换行) -->
            <template v-else>
              <span v-if="rowRelative(r)" class="bbs-summary-rel">{{ rowRelative(r) }}</span>
              <span class="bbs-summary-loc">{{ floorLabel(r) }}</span>
              <span v-if="rowTime(r)" class="bbs-summary-dateline">{{ rowTime(r) }}</span>
            </template>
            <span v-if="r.stale" class="bbs-summary-stale">Chờ cập nhật</span>
            <!-- 操作Khóa:搜索命中的根行(已压缩深层节点只读,不误删祖先链;选择模式Không có操作) -->
            <span v-if="!selectMode && !r.isChild" class="bbs-summary-acts">
              <button
                class="bbs-summary-act"
                type="button"
                :title="r.kind === 'comp' ? 'Chỉnh sửa tổng kết' : 'Chỉnh sửa tóm tắt'"
                @click="openEdit(r)"
              >
                <Icon name="edit" />
              </button>
              <button
                class="bbs-summary-act bbs-summary-del"
                type="button"
                :title="r.kind === 'comp' ? 'Xóa tổng kết (tầng dưới mở rộng)' : 'Xóa tóm tắt'"
                @click="onDelete(r)"
              >
                <Icon name="trash" />
              </button>
            </span>
          </header>
          <p class="bbs-summary-text">
            <template v-for="(seg, i) in highlightParts(r.text)" :key="i">
              <mark v-if="seg.hit" class="bbs-hit">{{ seg.t }}</mark>
              <template v-else>{{ seg.t }}</template>
            </template>
          </p>
        </div>
      </article>
    </div>
    <!-- 搜索Không có结果:与「还没Có摘要」区分 -->
    <div v-else-if="searching" class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="search" /></span>
      <p>Không có tóm tắt nào khớp với 「{{ searchQuery.trim() }}」. Hãy thử từ khóa khác hoặc nhập #số_tầng.</p>
    </div>
    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="summary" /></span>
      <p>Chưa có tóm tắt. Sẽ tự động tạo khi hội thoại đạt số tầng thiết lập, cũng có thể nhấn vào số tầng trong 'Tầng chưa tóm tắt' để bổ sung.</p>
    </div>

    <!-- 选择模式底部操作条:显示已选统计 + Gộp/Hủy bỏ。sticky 在页面底部 -->
    <div v-if="selectMode" class="bbs-select-bar">
      <span class="bbs-select-info">
        <template v-if="selectionSummary.count">
          Đã chọn {{ selectionSummary.count }} mục
          <template v-if="selectionSummary.floorLo >= 0">
            · Bao phủ {{ selectionSummary.floorLo === selectionSummary.floorHi ? `#${selectionSummary.floorLo}` : `#${selectionSummary.floorLo} - #${selectionSummary.floorHi}` }}
          </template>
          · Tạo {{ levelLabel(selectionSummary.level) }}
        </template>
        <template v-else>Chọn nhiều tóm tắt liên tiếp để gộp</template>
      </span>
      <span v-if="selectionSummary.count >= 2 && !canMerge" class="bbs-select-warn">Cần chọn tóm tắt liên tiếp</span>
      <button
        class="bbs-btn bbs-btn-sm bbs-btn-primary"
        type="button"
        :disabled="!canMerge || merging || engineState.running"
        @click="openMergeConfirm"
      >
        <span v-if="merging" class="bbs-pending-spin"></span>
        <Icon v-else name="plans" />
        Gộp tổng kết
      </button>
    </div>

    <!-- Gộp确认弹窗 -->
    <ConfirmDialog
      v-model:open="mergeConfirmOpen"
      title="Gộp tổng kết"
      confirmText="Gộp"
      @confirm="runMerge"
    >
      Sẽ gộp {{ selectionSummary.count }} mục tóm tắt đã chọn thành một {{ levelLabel(selectionSummary.level) }} (bỏ qua ngưỡng tổng kết tự động).
      Tóm tắt gốc sẽ được thu nạp vào tổng kết mới và ẩn khỏi danh sách (dữ liệu không mất, có thể xóa tổng kết mới để khôi phục). Tiếp tục?
    </ConfirmDialog>

    <!-- ===== ThêmKế hoạch / Huyền niệm弹窗 ===== -->
    <ModalMask :open="composerOpen" @close="closeComposer">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Thêm kế hoạch hoặc huyền niệm">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Thêm kế hoạch / huyền niệm</span>
          <button class="bbs-summary-act" type="button" title="Đóng" @click="closeComposer"><Icon name="close" /></button>
        </header>
        <div class="bbs-modal-field">
          <span class="bbs-modal-label">Loại</span>
          <div class="bbs-kind-toggle">
            <button type="button" class="bbs-kind" :class="{ 'is-on': newKind === 'plan' }" @click="newKind = 'plan'">Kế hoạch</button>
            <button type="button" class="bbs-kind" :class="{ 'is-on': newKind === 'suspense' }" @click="newKind = 'suspense'">Huyền niệm</button>
          </div>
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Nội dung</span>
          <textarea
            ref="contentInput"
            v-model="newContent"
            class="bbs-input bbs-modal-textarea"
            rows="3"
            placeholder="Mô tả kế hoạch hoặc huyền niệm này..."
            @keydown.enter.exact.prevent="addPlan"
          ></textarea>
        </label>
        <!-- 目标Thời gian仅「Kế hoạch」可填,Tùy chọn;Huyền niệm一般Không có目标Thời gian故不显示 -->
        <label v-if="newKind === 'plan'" class="bbs-modal-field">
          <span class="bbs-modal-label">Thời gian mục tiêu (tùy chọn)</span>
          <input
            v-model="newTargetTime"
            class="bbs-input"
            type="text"
            placeholder="Ví dụ: Sau giờ học / 1988/10/1; mơ hồ hoặc để trống đều được"
          />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeComposer">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!newContent.trim()" @click="addPlan">Thêm</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Chỉnh sửaKế hoạch / Huyền niệm弹窗 ===== -->
    <ModalMask :open="!!editingPlan" @close="cancelPlanEdit">
      <div v-if="editingPlan" class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa kế hoạch hoặc huyền niệm">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Chỉnh sửa{{ editingPlan.kind === 'suspense' ? 'Huyền niệm' : 'Kế hoạch' }}</span>
          <button class="bbs-summary-act" type="button" title="Đóng" @click="cancelPlanEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Nội dung</span>
          <textarea v-model="editingPlan.content" class="bbs-input bbs-modal-textarea" rows="3"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Thời gian tạo (Tùy chọn)</span>
          <input v-model="editingPlan.createdTime" class="bbs-input" type="text" placeholder="Thời gian trong truyện, ví dụ 1988/9/29" />
        </label>
        <label v-if="editingPlan.kind === 'plan'" class="bbs-modal-field">
          <span class="bbs-modal-label">Thời gian mục tiêu (tùy chọn)</span>
          <input v-model="editingPlan.targetTime" class="bbs-input" type="text" placeholder="Ví dụ: Sau giờ học / 1988/10/1; mơ hồ hoặc để trống đều được" />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelPlanEdit">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editingPlan.content.trim()" @click="savePlanEdit">Lưu</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Chỉnh sửa弹窗 ===== -->
    <ModalMask :open="!!editing" @close="cancelEdit">
      <div v-if="editing" class="bbs-modal" role="dialog" aria-modal="true" :aria-label="editing.kind === 'comp' ? 'Chỉnh sửa tổng kết' : 'Chỉnh sửa tóm tắt'">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">
            {{ editing.kind === 'comp' ? `Chỉnh sửa${levelLabel(editing.level)}` : `Chỉnh sửa tóm tắt · Tầng #${editing.msgIndex}` }}
          </span>
          <button class="bbs-summary-act" type="button" title="Đóng" @click="cancelEdit"><Icon name="close" /></button>
        </header>
        <!-- Thời gian仅叶子可Chỉnh sửa(起止两端);总结只压文本,Không cóThời gian字段 -->
        <div v-if="editing.kind === 'leaf'" class="bbs-modal-field bbs-time-pair">
          <label class="bbs-time-col">
            <span class="bbs-modal-label">Thời gian bắt đầu</span>
            <input v-model="editing.timeStart" class="bbs-input" type="text" placeholder="Ví dụ 1988/9/29 21:00" />
          </label>
          <label class="bbs-time-col">
            <span class="bbs-modal-label">Thời gian kết thúc</span>
            <input v-model="editing.timeEnd" class="bbs-input" type="text" placeholder="Ví dụ: 1988/9/29 21:30" />
          </label>
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">{{ editing.kind === 'comp' ? 'Nội dung tổng kết' : 'Nội dung tóm tắt' }}</span>
          <textarea v-model="editing.text" class="bbs-input bbs-modal-textarea" rows="8"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="saveEdit">Lưu</button>
        </footer>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
/* 起止Thời gian:两个输入框并排,各占一半 */
.bbs-time-pair {
  display: flex;
  gap: 10px;
}
.bbs-time-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* .bbs-section-head / .bbs-add-mini 已提升为 base.css 全局原子(摘要、场景共用) */

/* —— Huyền niệm簿折叠开关 ——
 * 标题行整体可点:左箭头 + 标题 + 金色计数标。Không có框透明,贴着 section-head 的左缘,
 * 不喧宾夺主——折叠是辅助操作,标题仍是主体。 */
.bbs-fold-head {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
/* Không có可折叠(零条目)时退化为普通标题:不是按钮观感、光标Mặc định */
.bbs-fold-head.is-static {
  cursor: default;
}
/* 折叠箭头:展开朝下,收拢转 -90° 朝右——像「合上这一章」。
   描边继承 currentColor(muted),hover 整行才点亮强调色。 */
.bbs-fold-caret {
  flex: 0 0 auto;
  color: var(--bbs-ink-muted);
  transition: transform 0.2s ease, color 0.15s;
}
.bbs-fold-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbs-fold-head:hover:not(.is-static) .bbs-fold-caret,
.bbs-fold-head:focus-visible .bbs-fold-caret {
  color: var(--bbs-accent);
}
/* 计数标:金底描边小药丸,呼应账册「结尾计数」,始终显示;收拢时尤其Có用——点明藏了多少条。
   margin-top:2px —— 标题是 CJK 大字,基线偏低,小药丸按行盒居中会偏上,下压 2px 才视觉对齐。 */
.bbs-fold-count {
  flex: 0 0 auto;
  margin-top: 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-pill);
  padding: 1px 9px;
  font-variant-numeric: tabular-nums;
}

/* —— 可收展容器:grid 1fr↔0fr,高度随Nội dung自适应,Không có需写死 max-height —— */
.bbs-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s ease;
}
.bbs-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
/* min-height:0 + overflow:hidden 才能让 0fr 真正压到零高(否则子项最小Nội dung高顶开) */
.bbs-fold-inner {
  min-height: 0;
  overflow: hidden;
}

.bbs-kind-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  padding: 3px;
  background: var(--bbs-surface-2);
  border-radius: var(--bbs-radius-sm);
}
.bbs-kind {
  padding: 5px 12px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-soft);
  font-size: 12px;
  cursor: pointer;
}
.bbs-kind.is-on {
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  box-shadow: 0 1px 2px oklch(0 0 0 / 0.08);
}
.bbs-plan-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
}
/* 卡片竖排:标签行在上(Loại药丸 + 右侧小XóaKhóa),Nội dung占满整宽在下 */
.bbs-plan {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
}
/* 标签行:Loại药丸靠左,XóaKhóa推到最右 */
.bbs-plan-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* Loại标签:小药丸,用颜色区分Kế hoạch/Huyền niệm */
.bbs-plan-kind {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
}
.bbs-plan-kind.plan {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-plan-kind.suspense {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
}
/* 楼层号:创建该Kế hoạch/Huyền niệm时所在楼层,描边定位标签;与摘要列表 #楼层 同款观感 */
.bbs-plan-floor {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  padding: 1px 7px;
  font-variant-numeric: tabular-nums;
}
/* 动作组(Chỉnh sửa/Xóa)推到最右;平时低调,桌面 hover/聚焦该卡才浮现 */
.bbs-plan-acts {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.bbs-plan:hover .bbs-plan-acts,
.bbs-plan:focus-within .bbs-plan-acts {
  opacity: 1;
}
/* 单个动作Khóa:小而 muted */
.bbs-plan-act {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbs-plan-act:hover {
  color: var(--bbs-accent);
  background: var(--bbs-surface-2);
}
.bbs-plan-del:hover {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
/* Nội dung:独占整宽,自然换行 */
.bbs-plan-content {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--bbs-ink);
  word-break: break-word;
}
/* Kế hoạchThời gian:立于/目标 两枚小标签,描边低调,目标用强调色区分 */
.bbs-plan-times {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbs-plan-time {
  font-size: 11px;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  padding: 1px 7px;
}
.bbs-plan-time-target {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
}
.bbs-plan-empty {
  margin: 14px 0 0;
  font-size: 13px;
  color: var(--bbs-ink-muted);
}

/* —— 当前状态 —— */
.bbs-state {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 20px;
  margin-top: 12px;
}
.bbs-state-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bbs-state-key {
  font-size: 11px;
  color: var(--bbs-accent);
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-pill);
  padding: 1px 8px;
}
.bbs-state-val {
  font-size: 14px;
  color: var(--bbs-ink);
}

.bbs-error {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--bbs-danger);
}

/* —— 立即总结按钮:摘要标题右侧的次级操作,小一号,带图标 —— */
.bbs-resummary-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  font-size: 12px;
}
/* 复用未摘要楼层的旋转环(.bbs-pending-spin),此处微调尺寸贴合按钮文字 */
.bbs-resummary-btn .bbs-pending-spin {
  width: 12px;
  height: 12px;
}
.bbs-resummary-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--bbs-ink-soft);
}

/* —— 未摘要楼层:待办面板,用强调色描边的卡片框起来,提示「这些楼还没摘」 —— */
.bbs-pending {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius);
  background: var(--bbs-accent-soft);
}
/* 标题行:标签靠左,Bổ sung tóm tắt hàng loạt按钮/进度推到右侧 */
.bbs-pending-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bbs-pending-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-accent);
}
/* Bổ sung tóm tắt hàng loạt按钮:推到标题行最右,小一号带图标 */
.bbs-batch-btn {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  font-size: 12px;
}
/* 批量进行中的进度块:旋转环 + 进度文字 + Hủy bỏKhóa */
.bbs-batch-progress {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--bbs-accent);
  font-variant-numeric: tabular-nums;
}
.bbs-batch-progress .bbs-pending-spin {
  width: 12px;
  height: 12px;
}
.bbs-batch-cancel {
  padding: 3px 9px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.bbs-batch-cancel:hover:not(:disabled) {
  color: var(--bbs-danger);
  border-color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
.bbs-batch-cancel:disabled {
  opacity: 0.55;
  cursor: default;
}
/* 标签后跟一枚计数小点,强化「Có N 楼待办」 */
.bbs-pending-label::after {
  content: attr(data-count);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.bbs-pending-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbs-pending-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbs-pending-chip:hover:not(:disabled) {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
}
.bbs-pending-chip:disabled {
  opacity: 0.55;
  cursor: default;
}
/* 生成中:小旋转环替代楼层号 */
.bbs-pending-spin {
  width: 13px;
  height: 13px;
  border: 2px solid var(--bbs-line-strong);
  border-top-color: var(--bbs-accent);
  border-radius: 50%;
  animation: bbs-pending-rot 0.7s linear infinite;
}
@keyframes bbs-pending-rot {
  to {
    transform: rotate(360deg);
  }
}

/* —— 分章分隔:Kế hoạch/Huyền niệm 与 摘要 两区之间的明确界线 —— */
/* 两侧细线在中间断开,嵌一枚金色小菱形——古籍分章的鱼尾标记,呼应纸墨主题 */
.bbs-divider {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 26px 0;
}
.bbs-divider::before,
.bbs-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--bbs-line-strong);
}
.bbs-divider-mark {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  transform: rotate(45deg);
  background: var(--bbs-accent);
  border-radius: 1px;
}

/* —— 摘要区工具行:标题右侧「选择 / 立即总结」并排 —— */
.bbs-summary-tools {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.bbs-summary-tools .bbs-btn-sm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  font-size: 12px;
}
/* 搜索切换Khóa激活态:点亮强调色,呼应「正在搜索」 */
.bbs-summary-tools .bbs-add-mini.is-on {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}

/* —— 搜索框:放大镜内嵌左侧,清空Khóa在右;整行圆角与输入一致 —— */
.bbs-search {
  position: relative;
  display: flex;
  align-items: center;
  margin-top: 12px;
}
.bbs-search-icon {
  position: absolute;
  left: 11px;
  color: var(--bbs-ink-muted);
  pointer-events: none;
  font-size: 15px;
}
.bbs-search-input {
  /* 左留放大镜位、右留清空Khóa位 */
  padding-left: 34px;
  padding-right: 34px;
}
.bbs-search-clear {
  position: absolute;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbs-search-clear:hover {
  color: var(--bbs-accent);
  background: var(--bbs-surface-2);
}

/* —— 搜索命中高亮:强调色淡底,不改字色保证可读 —— */
.bbs-hit {
  background: var(--bbs-accent-soft);
  color: inherit;
  border-radius: 3px;
  padding: 0 1px;
}

/* —— 摘要列表 —— */
.bbs-summary-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 14px;
}
/* 卡片视觉(.bbs-summary-card / meta / 标签 / 展开条 / 收起条)已提到 base.css 全局,
   供 SummaryNode.vue 与本页平铺列表共用(scoped 不跨组件)。此处只留本页专属:选择模式 + 底部操作条。 */

/* 选择模式:卡片左侧腾出复选框列,横向布局 */
.bbs-summary-list.is-selecting .bbs-summary-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: default;
}
.bbs-summary-card.is-selected {
  border-color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-summary-check {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  padding-top: 2px;
  cursor: pointer;
}
.bbs-summary-check .bbs-checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--bbs-accent);
  cursor: pointer;
}
/* 选择模式下 main 占满剩余宽 */
.bbs-summary-list.is-selecting .bbs-summary-main {
  flex: 1 1 auto;
  min-width: 0;
}

/* 展开开关(.bbs-expand-bar)、收起条(.bbs-collapse-footer)、展开态左缘(.is-expanded)
   均在 base.css,供 SummaryNode.vue 共用。 */

/* —— 选择模式底部操作条:sticky 贴底,强调色描边突出 —— */
.bbs-select-bar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius);
  background: var(--bbs-accent-soft);
  backdrop-filter: blur(3px);
}
.bbs-select-info {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--bbs-ink-soft);
  font-variant-numeric: tabular-nums;
}
.bbs-select-warn {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
  border-radius: var(--bbs-radius-sm);
  padding: 2px 8px;
}
.bbs-select-bar .bbs-pending-spin {
  width: 12px;
  height: 12px;
}

.bbs-empty {
  flex: 1;
}

/* —— Chỉnh sửa弹窗:外壳样式已提到 base.css 通用,这里只补本页专用的 textarea —— */
.bbs-modal-textarea {
  resize: vertical;
  min-height: 120px;
  line-height: 1.6;
  font-family: var(--bbs-font-sans);
}

/* ============ 触屏:Huyền niệm簿动作Khóa常显但低调(摘要卡片动作Khóa在 base.css 处理) ============ */
@media (hover: none) {
  .bbs-plan-acts {
    opacity: 1;
  }
  /* 触达区略放大到 ~32px(够点),图标维持小巧 */
  .bbs-plan-act {
    width: 32px;
    height: 32px;
    font-size: 15px;
  }
}

/* ============ 减弱动效:Huyền niệm簿箭头与收展瞬切(摘要展开动效在 SummaryNode/base.css) ============ */
@media (prefers-reduced-motion: reduce) {
  .bbs-fold-caret,
  .bbs-fold-wrap {
    transition: none;
  }
}

/* ============ 窄屏:Loại切换撑满、状态条整齐 ============ */
@media (max-width: 640px) {
  /* Thêm弹窗里的Loại切换:Kế hoạch | Huyền niệm 各占一半,撑满整行 */
  .bbs-kind-toggle {
    width: 100%;
  }
  .bbs-kind {
    flex: 1;
  }

  /* Thời gian/Địa điểm:窄屏整齐堆叠成两行,长Địa điểm不再把行挤乱 */
  .bbs-state {
    flex-direction: column;
    gap: 8px;
  }

  /* 摘要题首窄屏排布:绝对Thời gian(纯文本)较长,会把相对Thời gian+楼层标签挤满首行、把操作Khóa顶到第二行。
     用 order 把绝对Thời gian排到末尾并 flex-basis:100% 独占一行,首行只留「相对Thời gian标签 + 楼层标签 + 操作Khóa」。 */
  .bbs-summary-dateline,
  .bbs-summary-time {
    order: 99;
    flex-basis: 100%;
  }

  /* 摘要工具行:窄屏下「多选/立即总结」收成纯图标(藏文字、去边框),
     与左侧放大镜同权重、同尺寸——移动端带框带字的按钮视觉分量过重、喧宾夺主。 */
  .bbs-summary-tools .bbs-btn-label {
    display: none;
  }
  /* 三Khóa统一 32×32 方形图标:放大镜(.bbs-add-mini)与两个 .bbs-btn-sm 对齐,消除大小不一 */
  .bbs-summary-tools .bbs-add-mini,
  .bbs-summary-tools .bbs-btn-sm {
    width: 32px;
    height: 32px;
    padding: 0;
    justify-content: center;
    border-color: transparent;
    background: transparent;
    color: var(--bbs-ink-muted);
    font-size: 16px;
  }
  /* 保留放大镜激活态点亮(is-on),与桌面一致 */
  .bbs-summary-tools .bbs-add-mini.is-on {
    color: var(--bbs-accent);
    background: var(--bbs-accent-soft);
  }
  /* 立即总结进行中的旋转环仍需占位居中(此时Không có文字) */
  .bbs-summary-tools .bbs-resummary-btn {
    gap: 0;
  }
}
</style>
