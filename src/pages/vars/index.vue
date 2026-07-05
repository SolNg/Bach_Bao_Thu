<script setup lang="ts">
/**
 * 自定义Biến số页(MVU 式:一个 JSON 状态树 + Đường dẫn命令)。三块:
 *  ① 当前Trạng thái:AI 在剧情里用命令建/改出来的 JSON(派生,只读展示;可手动Chỉnh sửa整份 → 写回最新叶子)。
 *  ② 初始模板与说明:三层(全局/Nhân vật/聊天)各一份初始结构 + 给 AI 的说明,Gộp作为重放起点。
 *  ③ 导入/导出:分享Biến số结构(模板+说明,不含Giá trị)。
 * Giá trị永远每聊天独立(从各聊天叶子的 varOps 重放);改模板不需摘要,改「当前Giá trị」需要Có摘要(写最新叶子)。
 */
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import JsonTreeEditor from '@/components/JsonTreeEditor.vue';
import { currentCharKey } from '@/api/settings';
import { mergeTemplates, setVarsRoot } from '@/memory/apply';
import { refreshInjection } from '@/memory/inject';
import { derivedMeta, memory, replaceVarsTemplate } from '@/memory/store';
import type { JsonValue, VarTier } from '@/memory/types';
import { toast } from '@/st/toast';
import { computed, ref, watch } from 'vue';

const hasLeaf = computed(() => derivedMeta.hasLeaf);
// rev 每次重算派生(含切聊天/切Nhân vật)自增,借它让「是否CóNhân vật」「当前状态」随之刷新
const charAvailable = computed(() => { void derivedMeta.rev; return currentCharKey() !== null; });

const TIER_META: Record<VarTier, { label: string; hint: string }> = {
  global: { label: 'Toàn cục', hint: 'Mẫu ban đầu chia sẻ cho tất cả nhân vật và cuộc trò chuyện' },
  char: { label: 'Nhân vật', hint: 'Mẫu ban đầu chia sẻ cho tất cả trò chuyện của nhân vật hiện tại' },
  chat: { label: 'Trò chuyện', hint: 'Chỉ trò chuyện hiện tại' },
};
const TIER_ORDER: VarTier[] = ['global', 'char', 'chat'];

/** 解析成 JSON 对象(根须是对象);失败返回 null。 */
function parseObj(text: string): Record<string, JsonValue> | null {
  try {
    const o = JSON.parse(text || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/* ============ 当前状态 ============ */
const stateJson = computed(() => {
  void derivedMeta.rev;
  try {
    return JSON.stringify(memory.vars, null, 2);
  } catch {
    return '{}';
  }
});
const hasState = computed(() => Object.keys(memory.vars).length > 0);

const editStateOpen = ref(false);
const stateEdit = ref('');
const stateEditErr = ref('');
function openEditState() {
  if (!hasLeaf.value) return;
  stateEdit.value = stateJson.value;
  stateEditErr.value = '';
  editStateOpen.value = true;
}
function saveState() {
  const json = parseObj(stateEdit.value);
  if (!json) { stateEditErr.value = 'JSON không hợp lệ hoặc gốc không phải đối tượng {…}'; return; }
  if (!setVarsRoot(json)) { stateEditErr.value = 'Lưu thất bại: Cần có tóm tắt trước để ghi'; return; }
  refreshInjection();
  editStateOpen.value = false;
}

/* ============ 初始模板与说明(三层) ============ */
const defaultEditorTier = (): VarTier => (charAvailable.value ? 'char' : 'chat');
const editorTier = ref<VarTier>(defaultEditorTier());
const editorMode = ref<'tree' | 'source'>('tree'); // 结构Chỉnh sửa器(Mặc định)/ 源码
const editorTree = ref<Record<string, JsonValue>>({}); // 树形模式的工作副本
const editorJson = ref(''); // 源码模式文本
const editorMeaning = ref(''); // 含义:各字段是什么(主/副API都拿)
const editorRule = ref('');    // 变化规则:何时怎么改/可否新建(仅副API)
const jsonError = ref('');

function loadTier(t: VarTier) {
  const tpl = memory.varTemplates[t];
  editorTree.value = JSON.parse(JSON.stringify(tpl.json ?? {}));
  editorJson.value = Object.keys(tpl.json).length ? JSON.stringify(tpl.json, null, 2) : '{\n\n}';
  editorMeaning.value = tpl.meaning;
  editorRule.value = tpl.rule;
  jsonError.value = '';
}
function switchTier(t: VarTier) {
  if (t === 'char' && !charAvailable.value) return;
  editorTier.value = t;
  loadTier(t);
}
loadTier(editorTier.value); // 初始优先载入Nhân vật层;群聊/未进入时回退聊天层

// 树形Chỉnh sửa改动 → 同步一份到源码文本(切到源码时不落后)
watch(editorTree, v => { editorJson.value = JSON.stringify(v, null, 2); }, { deep: true });

// 切模式:进树形时用源码文本重解析(接住用户在源码里的Chỉnh sửa);进源码时用树重渲染
function switchMode(m: 'tree' | 'source') {
  if (m === editorMode.value) return;
  if (m === 'tree') {
    const obj = parseObj(editorJson.value);
    if (!obj) { jsonError.value = 'Mã nguồn JSON không hợp lệ, cần sửa trước khi chuyển sang chế độ xem cấu trúc'; return; }
    editorTree.value = obj;
    jsonError.value = '';
  } else {
    editorJson.value = JSON.stringify(editorTree.value, null, 2);
  }
  editorMode.value = m;
}

/** 取当前Chỉnh sửa中的 json(按模式来源);Không có效返回 null。 */
function currentEditorJson(): Record<string, JsonValue> | null {
  return editorMode.value === 'tree' ? editorTree.value : parseObj(editorJson.value);
}

function saveTemplate() {
  const t = editorTier.value;
  if (t === 'char' && !charAvailable.value) return;
  const json = currentEditorJson();
  if (!json) { jsonError.value = 'JSON không hợp lệ hoặc gốc không phải đối tượng {…}'; return; }
  jsonError.value = '';
  replaceVarsTemplate(t, { json, meaning: editorMeaning.value, rule: editorRule.value });
  refreshInjection();
  toast(`Đã lưu mẫu ${TIER_META[t].label}`, 'success');
}

/* ============ 导入 / 导出(模板+说明,不含Giá trị) ============ */
const exportOpen = ref(false);
const importOpen = ref(false);
const importText = ref('');
const importTier = ref<VarTier>('chat');

const exportText = computed(() => {
  const json = mergeTemplates(memory.varTemplates);
  const meaning = TIER_ORDER.map(t => memory.varTemplates[t].meaning.trim()).filter(Boolean).join('\n\n');
  const rule = TIER_ORDER.map(t => memory.varTemplates[t].rule.trim()).filter(Boolean).join('\n\n');
  return JSON.stringify({ app: 'ST-BaiBai-Book', kind: 'vars', version: 3, json, meaning, rule }, null, 2);
});
const hasAnyTemplate = computed(() => {
  void derivedMeta.rev;
  return TIER_ORDER.some(t => Object.keys(memory.varTemplates[t].json).length || memory.varTemplates[t].meaning.trim() || memory.varTemplates[t].rule.trim());
});

function openExport() {
  if (!hasAnyTemplate.value) return;
  exportOpen.value = true;
}
function openImport() {
  importText.value = '';
  importTier.value = 'chat';
  importOpen.value = true;
}
async function copyExport() {
  try {
    await navigator.clipboard.writeText(exportText.value);
    toast('Đã sao chép vào bảng tạm', 'success');
  } catch {
    toast('Sao chép thất bại, vui lòng chọn thủ công trong khung để sao chép', 'error');
  }
}
function downloadExport() {
  const blob = new Blob([exportText.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'baibai-vars.json';
  a.click();
  URL.revokeObjectURL(url);
}
function onImportFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { importText.value = String(reader.result ?? ''); };
  reader.readAsText(f);
}
function applyImport() {
  let parsed: unknown;
  try { parsed = JSON.parse(importText.value); } catch { toast('Phân tích JSON thất bại, vui lòng kiểm tra', 'error'); return; }
  // 接受 {json,meaning,rule} 包裹(兼容旧 guide → 并入 rule),或裸对象(当作 json)
  let json: Record<string, JsonValue> = {};
  let meaning = '';
  let rule = '';
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    if (o.json && typeof o.json === 'object' && !Array.isArray(o.json)) {
      json = o.json as Record<string, JsonValue>;
      meaning = typeof o.meaning === 'string' ? o.meaning : '';
      rule = typeof o.rule === 'string' ? o.rule : '';
      if (!meaning && !rule && typeof o.guide === 'string') rule = o.guide; // 兼容旧单一说明
    } else if (!o.kind) {
      json = o as Record<string, JsonValue>; // 裸对象
    }
  }
  if (!Object.keys(json).length && !meaning.trim() && !rule.trim()) { toast('Không phân tích được cấu trúc có thể nhập', 'error'); return; }
  let tier = importTier.value;
  if (tier === 'char' && !charAvailable.value) tier = 'chat';
  const cur = memory.varTemplates[tier];
  const mergedJson = { ...cur.json, ...json }; // 顶层浅Gộp(同名整体覆盖)
  const mergedMeaning = [cur.meaning.trim(), meaning.trim()].filter(Boolean).join('\n\n');
  const mergedRule = [cur.rule.trim(), rule.trim()].filter(Boolean).join('\n\n');
  replaceVarsTemplate(tier, { json: mergedJson, meaning: mergedMeaning, rule: mergedRule });
  refreshInjection();
  if (editorTier.value === tier) loadTier(tier); // 正在Chỉnh sửa该层则刷新Chỉnh sửa器
  importOpen.value = false;
  toast(`Đã nhập vào mẫu ${TIER_META[tier].label}`, 'success');
}
</script>

<template>
  <section class="bbs-page">
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">Biến số</h2>
      <div class="bbs-var-tools">
        <button class="bbs-add-mini" type="button" :disabled="!hasAnyTemplate" title="Xuất mẫu (chia sẻ)" @click="openExport">
          <Icon name="upload" />
        </button>
        <button class="bbs-add-mini" type="button" title="Nhập mẫu" @click="openImport">
          <Icon name="download" />
        </button>
      </div>
    </div>

    <hr class="bbs-rule" />

    <!-- 当前状态 -->
    <div class="bbs-var-blockhead">
      <span class="bbs-var-sub">Trạng thái hiện tại</span>
      <button class="bbs-mini-btn" type="button" :disabled="!hasLeaf" title="Chỉnh sửa thủ công toàn bộ JSON" @click="openEditState">
        <Icon name="edit" />Chỉnh sửa
      </button>
    </div>
    <pre v-if="hasState" class="bbs-json-view">{{ stateJson }}</pre>
    <p v-else class="bbs-var-emptyline">Chưa có trạng thái biến số. Khai báo mẫu ban đầu bên dưới, hoặc để AI tự tạo trong cốt truyện (ví dụ: thế lực mới, mục mới).</p>
    <p v-if="hasState && !hasLeaf" class="bbs-modal-hint">Sửa 'Giá trị hiện tại' cần có tóm tắt trước; hiện hiển thị là trạng thái ban đầu.</p>

    <!-- 初始模板与说明 -->
    <div class="bbs-var-blockhead bbs-var-tmplhead">
      <span class="bbs-var-sub">Mẫu ban đầu và mô tả</span>
    </div>
    <p class="bbs-modal-hint bbs-var-tmpltip">
      Cấu trúc ban đầu + Hướng dẫn cho AI. Gộp 3 tầng (Hội thoại &gt; Nhân vật &gt; Toàn cục) làm điểm bắt đầu phát lại, AI dùng lệnh trong cốt truyện để thêm/xóa/sửa. Thay đổi giá trị ban đầu sẽ ảnh hưởng đến giá trị hiện tại của toàn bộ cuộc trò chuyện.
    </p>

    <div class="bbs-typegrid bbs-var-tierpick">
      <button
        v-for="t in TIER_ORDER"
        :key="t"
        class="bbs-typebtn"
        :class="{ on: editorTier === t }"
        type="button"
        :disabled="t === 'char' && !charAvailable"
        @click="switchTier(t)"
      >
        {{ TIER_META[t].label }}
      </button>
    </div>
    <span class="bbs-modal-hint">
      {{ editorTier === 'char' && !charAvailable ? 'Hiện không có nhân vật đơn lẻ (trò chuyện nhóm/chưa vào), tạm thời không thể sửa tầng nhân vật' : TIER_META[editorTier].hint }}
    </span>

    <div class="bbs-modal-field">
      <div class="bbs-jte-fieldhead">
        <span class="bbs-modal-label">Cấu trúc ban đầu (có thể để trống để AI tự tạo từ đầu)</span>
        <div class="bbs-mode-toggle">
          <button class="bbs-mode-btn" :class="{ on: editorMode === 'tree' }" type="button" @click="switchMode('tree')">Cấu trúc</button>
          <button class="bbs-mode-btn" :class="{ on: editorMode === 'source' }" type="button" @click="switchMode('source')">Mã nguồn</button>
        </div>
      </div>
      <div v-if="editorMode === 'tree'" class="bbs-jte-wrap">
        <JsonTreeEditor v-model="editorTree" />
        <p v-if="!Object.keys(editorTree).length" class="bbs-jte-empty">Cấu trúc trống. Nhấn 'Thêm trường' để tạo cấu trúc muốn theo dõi, hoặc để trống cho AI tự xây dựng trong cốt truyện.</p>
      </div>
      <textarea v-else v-model="editorJson" class="bbs-input bbs-json-edit" spellcheck="false" rows="7"></textarea>
      <span v-if="jsonError" class="bbs-json-err">{{ jsonError }}</span>
    </div>
    <label class="bbs-modal-field">
      <span class="bbs-modal-label">Ý nghĩa (các trường là gì; cả AI cốt truyện và AI tóm tắt đều thấy để hiểu giá trị hiện tại)</span>
      <textarea
        v-model="editorMeaning"
        class="bbs-input bbs-modal-textarea"
        rows="5"
        placeholder="Ví dụ: Độ hảo cảm xxx là tình cảm của nhân vật đối với {{user}}, độ hảo cảm khác nhau sẽ dẫn đến hành vi khác nhau."
      ></textarea>
    </label>
    <label class="bbs-modal-field">
      <span class="bbs-modal-label">Quy tắc thay đổi (khi nào/cách thay đổi, có cho phép tạo mới không; chỉ gửi cho AI tóm tắt, không chèn vào cốt truyện để tránh lặp lại)</span>
      <textarea
        v-model="editorRule"
        class="bbs-input bbs-modal-textarea"
        rows="5"
        placeholder="Ví dụ: Mỗi khi nhân vật có sự kiện với {{user}}, độ hảo cảm sẽ thay đổi, nhưng mỗi lần không quá 5"
      ></textarea>
    </label>
    <div class="bbs-modal-foot bbs-var-savefoot">
      <button
        class="bbs-btn bbs-btn-primary"
        type="button"
        :disabled="editorTier === 'char' && !charAvailable"
        @click="saveTemplate"
      >
        <Icon name="check" />Lưu mẫu {{ TIER_META[editorTier].label }}
      </button>
    </div>

    <!-- Chỉnh sửa当前Giá trị -->
    <ModalMask :open="editStateOpen" @close="editStateOpen = false">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa giá trị biến số hiện tại">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Chỉnh sửa giá trị hiện tại</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="editStateOpen = false"><Icon name="close" /></button>
        </header>
        <p class="bbs-modal-hint">Chỉnh sửa trực tiếp toàn bộ JSON, khi lưu sẽ ghi vào tầng tóm tắt mới nhất (xóa tầng đó có thể hoàn tác).</p>
        <textarea v-model="stateEdit" class="bbs-input bbs-json-edit bbs-io-area" spellcheck="false"></textarea>
        <span v-if="stateEditErr" class="bbs-json-err">{{ stateEditErr }}</span>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="editStateOpen = false">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="saveState">Lưu</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 导出 -->
    <ModalMask :open="exportOpen" @close="exportOpen = false">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Xuất mẫu biến số">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Xuất mẫu biến số</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="exportOpen = false"><Icon name="close" /></button>
        </header>
        <p class="bbs-modal-hint">Cấu trúc ban đầu sau khi hợp nhất 3 tầng + mô tả (không kèm giá trị cụ thể). Sao chép và gửi để chia sẻ.</p>
        <textarea class="bbs-input bbs-json-edit bbs-io-area" readonly :value="exportText"></textarea>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="downloadExport"><Icon name="download" />Tải tập tin</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="copyExport"><Icon name="check" />Sao chép</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 导入 -->
    <ModalMask :open="importOpen" @close="importOpen = false">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Nhập mẫu biến số">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Nhập mẫu biến số</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="importOpen = false"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Dán JSON mẫu</span>
          <textarea v-model="importText" class="bbs-input bbs-json-edit bbs-io-area" spellcheck="false" placeholder="Dán JSON mẫu biến số được chia sẻ vào đây, hoặc chọn tệp bên dưới"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Hoặc nhập từ tập tin</span>
          <input class="bbs-input" type="file" accept="application/json,.json" @change="onImportFile" />
        </label>
        <div class="bbs-modal-field">
          <span class="bbs-modal-label">Nhập vào tầng nào</span>
          <div class="bbs-typegrid">
            <button
              v-for="t in TIER_ORDER"
              :key="t"
              class="bbs-typebtn"
              :class="{ on: importTier === t }"
              type="button"
              :disabled="t === 'char' && !charAvailable"
              @click="importTier = t"
            >
              {{ TIER_META[t].label }}
            </button>
          </div>
          <span class="bbs-modal-hint">Hợp nhất vào mẫu tầng đó (các trường cùng tên ở tầng trên cùng sẽ bị ghi đè); phần mô tả sẽ được bổ sung.</span>
        </div>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="importOpen = false">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!importText.trim()" @click="applyImport">Nhập</button>
        </footer>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>
/* 不设 height:100% —— 本页是自然文档流,靠 .bbs-body 滚动。
   钉死高度会让 flex 列把「当前状态」pre(自带 overflow)挤到几乎没高度,什么都看不到。 */
.bbs-page {
  display: flex;
  flex-direction: column;
}
.bbs-var-tools {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

/* 小节标题行 */
.bbs-var-blockhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.bbs-var-tmplhead {
  margin-top: 22px;
}
.bbs-var-sub {
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-ink);
  letter-spacing: 0.02em;
}
.bbs-mini-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  font-size: 12px;
  cursor: pointer;
}
.bbs-mini-btn:hover:not(:disabled) {
  border-color: var(--bbs-accent);
  color: var(--bbs-accent);
}
.bbs-mini-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 当前状态 JSON 视图 */
.bbs-json-view {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  min-height: 160px;
  max-height: 60vh;
  overflow-y: auto;
}
.bbs-var-emptyline {
  margin: 0;
  padding: 14px;
  border: 1px dashed var(--bbs-line-strong);
  border-radius: var(--bbs-radius);
  color: var(--bbs-ink-muted);
  font-size: 12.5px;
  line-height: 1.6;
}
.bbs-var-tmpltip {
  margin-top: -2px;
  margin-bottom: 10px;
}

.bbs-var-tierpick {
  margin-bottom: 6px;
}
.bbs-typegrid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbs-typebtn {
  flex: 1 1 auto;
  padding: 7px 10px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--bbs-dur) var(--bbs-ease), border-color var(--bbs-dur) var(--bbs-ease), color var(--bbs-dur) var(--bbs-ease);
}
.bbs-typebtn:hover:not(:disabled) {
  border-color: var(--bbs-accent);
  color: var(--bbs-accent);
}
.bbs-typebtn.on {
  background: var(--bbs-accent);
  border-color: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
.bbs-typebtn:disabled {
  opacity: 0.5;
  cursor: default;
}

.bbs-json-edit {
  resize: vertical;
  min-height: 120px;
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre;
}
/* 结构 / 源码 模式切换 */
.bbs-jte-fieldhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.bbs-mode-toggle {
  display: inline-flex;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  overflow: hidden;
}
.bbs-mode-btn {
  padding: 4px 12px;
  border: 0;
  background: var(--bbs-surface);
  color: var(--bbs-ink-muted);
  font-size: 12px;
  cursor: pointer;
}
.bbs-mode-btn.on {
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
.bbs-jte-wrap {
  padding: 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
}
.bbs-jte-empty {
  margin: 0;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  line-height: 1.6;
}
.bbs-json-err {
  font-size: 11.5px;
  color: var(--bbs-danger);
}
.bbs-modal-textarea {
  resize: vertical;
  min-height: 56px;
  font-family: inherit;
}
.bbs-modal-hint {
  font-size: 11.5px;
  color: var(--bbs-ink-muted);
  line-height: 1.55;
}
.bbs-var-savefoot {
  margin-top: 12px;
}
.bbs-io-area {
  min-height: 200px;
}
</style>
