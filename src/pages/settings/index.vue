<script setup lang="ts">
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { fetchModels, testChannel } from '@/api/client';
import { apiSettings, newChannel, resolveVectorModel, sanitizeTagName, type ApiChannel } from '@/api/settings';
import { getContext } from '@/st/context';
import {
  JAILBREAK_PROMPT,
  RESUMMARY2_MACROS,
  RESUMMARY2_PROMPT,
  RESUMMARY_MACROS,
  RESUMMARY_PROMPT,
  SUMMARY_MACROS,
  SUMMARY_PROMPT,
  type PromptMacro,
} from '@/memory/prompts';
import { TIME_TAG_PROMPT } from '@/memory/timeTag';
import { clearVectorIndex, syncVectorIndex } from '@/memory/vector';
import { resetVectorStoreProbe, vectorBackendKind } from '@/memory/vector/store';
import { checkForUpdate, performUpdate, updateState } from '@/memory/update';
import { recallDebug } from '@/memory/vector/debug';
import { computeCarryoverPlan, createNewChatWithCarryover, type CarryoverPlan } from '@/memory/carryover';
import { computeMigrationPlan, runHoraeMigration, type MigrationPlan } from '@/memory/migrate';
import { ui, THEMES, ORB_SHAPES, type NavPosition } from '@/state/ui';
import { uploadOrbImage } from '@/st/upload';
import { toast } from '@/st/toast';
import { computed, nextTick, onMounted, ref } from 'vue';

const navOptions: { value: NavPosition; label: string }[] = [
  { value: 'auto', label: 'Tự động' },
  { value: 'top', label: 'Trên cùng' },
  { value: 'bottom', label: 'Dưới cùng' },
];

/* —— 悬浮球自定义图标:选图 → 压缩上传到 ST 服务器 → 存Đường dẫn串(跨设备同步) —— */
const orbFileInput = ref<HTMLInputElement | null>(null);
const orbUploading = ref(false);
function pickOrbImage() {
  orbFileInput.value?.click();
}
async function onOrbFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // 复位,允许重复选同一文件
  if (!file) return;
  orbUploading.value = true;
  try {
    ui.orbImage = await uploadOrbImage(file);
    toast('Đã cập nhật biểu tượng quả cầu lơ lửng', 'success');
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Tải lên thất bại', 'error');
  } finally {
    orbUploading.value = false;
  }
}
function resetOrbImage() {
  ui.orbImage = '';
}

/* —— Kênh:列表只读展示,编辑/新建都在弹窗里进行,避免一长列表平铺误触。
   两套独立Kênh:'api'= API phụ (tóm tắt/tổng kết),'vector'=Ký ức vectơ。弹窗按 scope 操作对应列表。 —— */
type ChannelScope = 'api' | 'vector';
// editingId:正在编辑的「已CóKênh」id;新建时为 null。仅用于「Hoàn tất」时定位写回目标。
const editingId = ref<string | null>(null);
const editingScope = ref<ChannelScope>('api');
// 当前 scope 对应的Kênh数组(增删/查找都走它)。向量已改扁平端点,只剩API phụ 用Kênh。
function channelsOf(_scope: ChannelScope): ApiChannel[] {
  return apiSettings.channels;
}
// 编辑用「草稿副本」:v-model 全改在草稿上,只Có点「Hoàn tất」才写回 apiSettings(避免每敲一字就触发存盘)。
// 弹窗开关也以它为准:草稿存在 = 弹窗打开。
const editingChannel = ref<ApiChannel | null>(null);
// 深拷贝Kênh(纯数据,JSON 即可),切断与 apiSettings 真身的引用
function cloneChannel(ch: ApiChannel): ApiChannel {
  return JSON.parse(JSON.stringify(ch)) as ApiChannel;
}
// 密钥Mặc định隐藏;每次打开/Đóng弹窗都复位,避免密钥意外保持明文
const showKey = ref(false);

// Loại trừ tham số:内部存 string[],编辑时用逗号分隔的单行文本承载,读/写两向转换。
const excludeParamsText = computed<string>({
  get: () => editingChannel.value?.excludeParams.join(', ') ?? '',
  set: v => {
    const ch = editingChannel.value;
    if (!ch) return;
    ch.excludeParams = v
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  },
});

function addChannel(scope: ChannelScope = 'api') {
  showKey.value = false;
  editingScope.value = scope;
  editingId.value = null; // null = 新建,Hoàn tất时 push
  editingChannel.value = newChannel(); // 草稿,尚未进 apiSettings
}
function openChannel(id: string, scope: ChannelScope = 'api') {
  const src = channelsOf(scope).find(c => c.id === id);
  if (!src) return;
  showKey.value = false;
  editingScope.value = scope;
  editingId.value = id;
  editingChannel.value = cloneChannel(src); // 编辑草稿副本,不动真身
}
/** Hủy bỏ(× / 点遮罩):丢弃草稿,不写回 apiSettings(Không có论新建还是编辑,改动都作废)。 */
function closeChannel() {
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
/** Hoàn tất:把草稿写回 apiSettings —— 新建则 push,编辑则按 id 覆盖。此时才触发存盘。 */
function confirmChannel() {
  const draft = editingChannel.value;
  if (draft) {
    const list = channelsOf(editingScope.value);
    if (editingId.value) {
      const idx = list.findIndex(c => c.id === editingId.value);
      if (idx >= 0) list[idx] = draft;
      else list.push(draft); // 编辑期间原Kênh被删等异常 → 兜底为新增
    } else {
      list.push(draft);
    }
  }
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
// Xóa kênh前的二次确认:点Xóa先开确认弹窗,确认后才真正删。
const confirmDeleteOpen = ref(false);
function askRemoveChannel() {
  confirmDeleteOpen.value = true;
}
function confirmRemoveChannel() {
  confirmDeleteOpen.value = false;
  // Xóa针对「已CóKênh」(editingId);新建草稿尚未入库,等同直接丢弃草稿
  if (editingId.value) removeChannel(editingId.value);
  editingId.value = null;
  editingChannel.value = null;
}
function removeChannel(id: string) {
  const scope = editingScope.value;
  const list = channelsOf(scope);
  const idx = list.findIndex(c => c.id === id);
  if (idx >= 0) list.splice(idx, 1);
  // 清理指派:API phụ 清两类摘要指派(向量已改扁平端点,不再走Kênh系统)
  if (scope === 'api') {
    if (apiSettings.assignments.summary === id) apiSettings.assignments.summary = '';
    if (apiSettings.assignments.resummary === id) apiSettings.assignments.resummary = '';
  }
}

const testing = ref<Record<string, string>>({});
async function doTest(ch: ApiChannel) {
  testing.value[ch.id] = 'Đang kiểm tra...';
  const r = await testChannel(ch);
  testing.value[ch.id] = r.message;
}

// 各Kênh拉取到的Mô hình列表 + 拉取状态
const models = ref<Record<string, string[]>>({});
const loadingModels = ref<Record<string, boolean>>({});
async function pullModels(ch: ApiChannel) {
  loadingModels.value[ch.id] = true;
  testing.value[ch.id] = '';
  try {
    const list = await fetchModels(ch);
    models.value[ch.id] = list;
    if (list.length && !ch.model) ch.model = list[0];
    if (!list.length) testing.value[ch.id] = 'Không trả về mô hình nào';
  } catch (e) {
    testing.value[ch.id] = e instanceof Error ? e.message : String(e);
  } finally {
    loadingModels.value[ch.id] = false;
  }
}

/* —— Mô hình可搜索下拉(combobox):输入框既是当前Giá trị也是过滤词,聚焦弹出过滤列表 —— */
const modelMenuOpen = ref(false);
const modelQuery = ref(''); // 聚焦后用户输入的过滤词;失焦时清空
// 已拉取到的当前KênhMô hình列表
const modelList = computed<string[]>(() => {
  const id = editingChannel.value?.id;
  return id ? models.value[id] ?? [] : [];
});
// 过滤:Có query 按子串(大小写不敏感)过滤;为空则显示全部。性能上限 200 条,避免超长列表卡顿。
const filteredModels = computed<string[]>(() => {
  const q = modelQuery.value.trim().toLowerCase();
  const list = modelList.value;
  const out = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
  return out.slice(0, 200);
});
function openModelMenu() {
  modelQuery.value = '';
  modelMenuOpen.value = true;
}
function pickModel(m: string) {
  if (editingChannel.value) editingChannel.value.model = m;
  modelMenuOpen.value = false;
  modelQuery.value = '';
}
// 失焦延迟Đóng,让 option 的 mousedown/click 先生效
function closeModelMenuSoon() {
  setTimeout(() => {
    modelMenuOpen.value = false;
    modelQuery.value = '';
  }, 150);
}

/* —— Lời nhắc tùy chỉnh:列表(摘要/总结/破限/Thời gian标签),点开在弹窗里编辑大文本 —— */
type PromptKey = 'summary' | 'resummary' | 'resummary2' | 'jailbreak' | 'timeTag';
interface PromptMeta {
  key: PromptKey;
  label: string;
  hint: string;
  builtin: string;
  macros: PromptMacro[];
}
const PROMPT_METAS: PromptMeta[] = [
  {
    key: 'summary',
    label: 'Lời nhắc tóm tắt',
    hint: 'Sắp xếp hội thoại từng tầng thành ký ức cấu trúc (nội dung tóm tắt + thời gian/địa điểm/vật phẩm/kế hoạch).',
    builtin: SUMMARY_PROMPT,
    macros: SUMMARY_MACROS,
  },
  {
    key: 'resummary',
    label: 'Lời nhắc tổng kết',
    hint: 'Nén nhiều tóm tắt tầng thành một tổng kết L1 (tổng kết thông thường, cố định 300-500 chữ).',
    builtin: RESUMMARY_PROMPT,
    macros: RESUMMARY_MACROS,
  },
  {
    key: 'resummary2',
    label: 'Lời nhắc tổng kết cấp hai',
    hint: 'Nén nhiều tổng kết lên thêm một tầng (L1+ → tầng cao hơn). Số chữ mục tiêu nới lỏng linh hoạt theo quy mô đầu vào ({{target}}), giảm thiểu mất mát thông tin.',
    builtin: RESUMMARY2_PROMPT,
    macros: RESUMMARY2_MACROS,
  },
  {
    key: 'jailbreak',
    label: 'Lời nhắc vượt giới hạn',
    hint: 'Thêm vào yêu cầu tóm tắt/tổng kết dưới dạng system ghim đầu, giúp giảm tỷ lệ từ chối của API phụ. Để trống sẽ dùng mặc định.',
    builtin: JAILBREAK_PROMPT,
    macros: [],
  },
  {
    key: 'timeTag',
    label: 'Lời nhắc cố định (nhãn thời gian)',
    hint: 'Chèn vào hội thoại chính, yêu cầu AI xuất nhãn thời gian ở đầu/cuối mỗi câu chuyện làm mốc thời gian (tóm tắt và cốt truyện mới sẽ căn chỉnh theo đây). Cần bật công tắc "Nhãn thời gian cốt truyện" bên dưới. Để trống sẽ dùng mặc định.',
    builtin: TIME_TAG_PROMPT,
    macros: [],
  },
];

// 正在编辑的提示词;draft 是草稿,点「Hoàn tất」才写回 apiSettings(Hủy bỏ则丢弃)。
const editingPrompt = ref<PromptMeta | null>(null);
const promptDraft = ref('');
const promptArea = ref<HTMLTextAreaElement | null>(null);

// 该任务是否Đã tùy chỉnh(非空即视为已覆盖内置)
function isCustom(key: PromptKey): boolean {
  return apiSettings.prompts[key].trim().length > 0;
}

function openPrompt(meta: PromptMeta) {
  editingPrompt.value = meta;
  // Đã tùy chỉnh→载入用户内容;未自定义→预填内置模板,方便直接在其上改
  promptDraft.value = apiSettings.prompts[meta.key].trim() || meta.builtin;
}
function closePrompt() {
  editingPrompt.value = null;
  promptDraft.value = '';
}
function savePrompt() {
  const meta = editingPrompt.value;
  if (!meta) return;
  // 草稿与内置完全一致→存空串(回落内置),避免把模板冗余存进设置、也便于显示「Mặc định」
  const v = promptDraft.value.trim();
  apiSettings.prompts[meta.key] = v === meta.builtin.trim() ? '' : promptDraft.value;
  closePrompt();
}
// 「恢复Mặc định」:把草稿重置回内置模板(保存后即回落内置)
function resetPrompt() {
  if (editingPrompt.value) promptDraft.value = editingPrompt.value.builtin;
}

/* —— Ký ức vectơ:三个Mô hìnhNhân vật,embedding 为基准,后两者留空复用它 —— */
type VectorRole = 'embedding' | 'rerank' | 'queryRewrite';
interface VectorRoleMeta {
  key: VectorRole;
  label: string;
}
const VECTOR_ROLES: VectorRoleMeta[] = [
  { key: 'embedding', label: 'Embedding (Vectơ hóa, bắt buộc)' },
  { key: 'rerank', label: 'Rerank (Sắp xếp lại)' },
  { key: 'queryRewrite', label: 'Viết lại truy vấn' },
];

/* —— 向量端点:每Nhân vật直接填 地址/密钥/Mô hình;Mô hình可一Khóa拉取(combobox)。 —— */
const vecShowKey = ref<Record<VectorRole, boolean>>({ embedding: false, rerank: false, queryRewrite: false });
// 三个端点卡片各自折叠,Mặc định全收起,只露标题,需要时再展开。
const vecEpOpen = ref<Record<VectorRole, boolean>>({ embedding: false, rerank: false, queryRewrite: false });
const vecModels = ref<Record<VectorRole, string[]>>({ embedding: [], rerank: [], queryRewrite: [] });
const vecLoadingModels = ref<Record<VectorRole, boolean>>({ embedding: false, rerank: false, queryRewrite: false });
const vecModelMsg = ref<Record<VectorRole, string>>({ embedding: '', rerank: '', queryRewrite: '' });
// combobox:当前展开的Nhân vật(null=都收起)+ 过滤词
const vecModelMenuOpen = ref<VectorRole | null>(null);
const vecModelQuery = ref('');

async function pullVecModels(role: VectorRole) {
  // 解析回落后的地址/密钥:rerank/query 留空时自动用 Embedding 的去拉(Mô hình仍写回本Nhân vật)
  const ep = resolveVectorModel(role);
  if (!ep.url.trim()) {
    vecModelMsg.value[role] = role === 'embedding' ? 'Vui lòng điền địa chỉ Embedding trước' : 'Vui lòng điền địa chỉ của nhân vật này hoặc Embedding trước';
    return;
  }
  vecLoadingModels.value[role] = true;
  vecModelMsg.value[role] = '';
  try {
    const list = await fetchModels({ url: ep.url, key: ep.key });
    vecModels.value[role] = list;
    if (list.length && !apiSettings.vector[role].model) apiSettings.vector[role].model = list[0];
    if (!list.length) vecModelMsg.value[role] = 'Không trả về mô hình nào';
  } catch (e) {
    vecModelMsg.value[role] = e instanceof Error ? e.message : String(e);
  } finally {
    vecLoadingModels.value[role] = false;
  }
}
function filteredVecModels(role: VectorRole): string[] {
  const q = vecModelQuery.value.trim().toLowerCase();
  const list = vecModels.value[role] ?? [];
  const out = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
  return out.slice(0, 200);
}
function openVecModelMenu(role: VectorRole) {
  vecModelQuery.value = '';
  vecModelMenuOpen.value = role;
}
function pickVecModel(role: VectorRole, m: string) {
  apiSettings.vector[role].model = m;
  vecModelMenuOpen.value = null;
  vecModelQuery.value = '';
}
function closeVecModelMenuSoon() {
  setTimeout(() => {
    vecModelMenuOpen.value = null;
    vecModelQuery.value = '';
  }, 150);
}

/* —— 向量后端Loại:'backend' Bách Bảo Khố后端 / 'local' 本地降级;探测一次,展示当前在用哪个。 —— */
const vecBackend = ref<'backend' | 'local' | 'unknown'>('unknown');
async function refreshVecBackend(): Promise<void> {
  try {
    vecBackend.value = await vectorBackendKind();
  } catch {
    vecBackend.value = 'unknown';
  }
}
onMounted(refreshVecBackend);

/* —— 检测更新:版本区块 + 确认弹窗 —— */
const updateConfirmOpen = ref(false);
// 进设置页时静默重查一次(force:绕开「会话只查一次」,让用户每次进设置页都拿最新结论)
onMounted(() => void checkForUpdate(true));
function openUpdateConfirm() {
  if (updateState.available) updateConfirmOpen.value = true;
}
async function confirmUpdate() {
  updateConfirmOpen.value = false;
  const toastr = (globalThis as Record<string, any>).toastr;
  try {
    await performUpdate();
    // performUpdate 成功后会自动刷新页面;走到这里通常是已触发刷新倒计时
    toastr?.success?.('Cập nhật thành công, đang làm mới trang...', 'Bách Bảo Thư');
  } catch (e) {
    toastr?.error?.(`Cập nhật thất bại:${e instanceof Error ? e.message : String(e)}`, 'Bách Bảo Thư');
  }
}

/* —— Bảo trì chỉ mục:手动Tái tạo chỉ mục vectơ cho trò chuyện hiện tại —— */
const vecIndexing = ref(false);
const vecIndexMsg = ref('');
async function doRebuildIndex() {
  if (vecIndexing.value) return;
  vecIndexing.value = true;
  vecIndexMsg.value = '';
  resetVectorStoreProbe(); // 重测后端,确保索引落到当前真实可用的 store
  try {
    const n = await syncVectorIndex();
    vecIndexMsg.value = n > 0 ? `Đã tạo chỉ mục cho ${n} tóm tắt mới.` : 'Không có chỉ mục nào cần thêm mới (đã là mới nhất).';
  } catch (e) {
    vecIndexMsg.value = `Tạo chỉ mục thất bại:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    vecIndexing.value = false;
    void refreshVecBackend();
  }
}

// 清空当前聊天向量索引:破坏性操作,点一次先要二次确认,再点才真清。
const vecClearing = ref(false);
const vecClearConfirm = ref(false);
async function doClearIndex() {
  if (vecClearing.value) return;
  if (!vecClearConfirm.value) {
    vecClearConfirm.value = true;
    return;
  }
  vecClearConfirm.value = false;
  vecClearing.value = true;
  vecIndexMsg.value = '';
  try {
    const n = await clearVectorIndex();
    vecIndexMsg.value = `Đã xóa trống chỉ mục vectơ trò chuyện hiện tại (xóa ${n} mục). Có thể nhấn 'Tái tạo' để làm lại từ đầu.`;
  } catch (e) {
    vecIndexMsg.value = `Xóa trống thất bại:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    vecClearing.value = false;
    void refreshVecBackend();
  }
}

/* —— Tạo đối thoại mới kèm dữ liệu —— */
const carrying = ref(false);
const carryMsg = ref('');
const carryConfirmOpen = ref(false);
// 携带Kế hoạch:展开面板时实时算(纯读 chat,不缓存,避免切聊天后过期)
const carryPlan = computed<CarryoverPlan>(() => computeCarryoverPlan());
async function runCarryover() {
  carryConfirmOpen.value = false;
  carrying.value = true;
  carryMsg.value = '';
  try {
    const ok = await createNewChatWithCarryover();
    carryMsg.value = ok ? 'Đã tạo cuộc trò chuyện mới.' : 'Tạo mới chưa hoàn tất (xem chi tiết trong thông báo).';
  } catch (e) {
    carryMsg.value = `Tạo thất bại:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    carrying.value = false;
  }
}

/* —— Di chuyển từ bản cũ Horae —— */
const migrating = ref(false);
const migrateMsg = ref('');
const migrateConfirmOpen = ref(false);
// 迁移Kế hoạch:展开面板时实时算(纯读当前 chat 的 horae_meta,不缓存)
const migratePlan = computed<MigrationPlan>(() => computeMigrationPlan());
// 确认文案随「是否覆盖」变化
const migrateConfirmText = computed(() =>
  migratePlan.value.willOverwrite
    ? 'Cuộc trò chuyện hiện tại đã có dữ liệu Bách Bảo Thư, di chuyển sẽ ghi đè tóm tắt hiện có và ghi dữ liệu vào các tầng. Tiếp tục không?'
    : 'Sẽ di chuyển dữ liệu cũ Horae trong cuộc trò chuyện hiện tại thành ký ức Bách Bảo Thư. Tiếp tục không?',
);
async function runMigrate() {
  migrateConfirmOpen.value = false;
  migrating.value = true;
  migrateMsg.value = '';
  try {
    const ok = await runHoraeMigration();
    migrateMsg.value = ok ? 'Di chuyển hoàn tất.' : 'Di chuyển chưa hoàn tất (xem chi tiết trong thông báo).';
  } catch (e) {
    migrateMsg.value = `Di chuyển thất bại:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    migrating.value = false;
  }
}

/* —— Loại trừ nhân vật:勾选的Tên nhân vật(含重名卡)的聊天里,记忆系统所Có功能都不生效。
   按「Tên」排除,所以同名卡是一批一起排除。列表很长时易卡,故:① 仅在弹窗打开时取/去重Tên nhân vật;
   ② 带搜索框过滤;③ 用 v-show + 子串匹配,渲染量随搜索收敛。 —— */
const excludeOpen = ref(false);
const excludeSearch = ref('');

// 弹窗打开时一次性算出去重后的Tên nhân vật(按名排序),Đóng后不再持Có,避免常驻大列表。
const charNames = computed<string[]>(() => {
  if (!excludeOpen.value) return [];
  const chars = getContext()?.characters ?? [];
  const seen = new Set<string>();
  for (const c of chars) {
    const n = c?.name?.trim();
    if (n) seen.add(n);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
});

// 过滤:空搜索显示全部;否则大小写不敏感子串匹配
const filteredCharNames = computed<string[]>(() => {
  const q = excludeSearch.value.trim().toLowerCase();
  if (!q) return charNames.value;
  return charNames.value.filter(n => n.toLowerCase().includes(q));
});

function openExclude() {
  excludeSearch.value = '';
  excludeOpen.value = true;
}
function closeExclude() {
  excludeOpen.value = false;
}
function isExcluded(name: string): boolean {
  return apiSettings.excludedChars.includes(name);
}
function toggleExcluded(name: string) {
  const list = apiSettings.excludedChars;
  const idx = list.indexOf(name);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(name);
}

/* —— 排除世界书:摘要/总结时不带这些整本世界书的条目。复刻Loại trừ nhân vật的搜索+勾选弹窗;
   世界书名从 ST 的 getWorldInfoNames()(全部已加载的世界书文件)取。 —— */
const excludeWorldOpen = ref(false);
const excludeWorldSearch = ref('');

// 旧版 ST(如 1.13.5)的 getContext() 没Có getWorldInfoNames,退而从主页面世界书
// 下拉框 #world_editor_select 读选项文本(value="" 是占位项,跳过)。
function readWorldNamesFromDom(): string[] {
  const opts = document.querySelectorAll<HTMLOptionElement>('#world_editor_select option');
  const out: string[] = [];
  for (const o of opts) {
    if (o.value !== '' && o.textContent) out.push(o.textContent);
  }
  return out;
}

// 弹窗打开时一次性取世界书名(去重去空、按名排序);Đóng后不持Có。
const worldNames = computed<string[]>(() => {
  if (!excludeWorldOpen.value) return [];
  const getNames = getContext()?.getWorldInfoNames;
  const names = getNames ? getNames() : readWorldNamesFromDom();
  const seen = new Set<string>();
  for (const n of names) {
    const t = n?.trim();
    if (t) seen.add(t);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
});

const filteredWorldNames = computed<string[]>(() => {
  const q = excludeWorldSearch.value.trim().toLowerCase();
  if (!q) return worldNames.value;
  return worldNames.value.filter(n => n.toLowerCase().includes(q));
});

function openExcludeWorld() {
  excludeWorldSearch.value = '';
  excludeWorldOpen.value = true;
}
function closeExcludeWorld() {
  excludeWorldOpen.value = false;
}
function isWorldExcluded(name: string): boolean {
  return apiSettings.excludedWorldNames.includes(name);
}
function toggleWorldExcluded(name: string) {
  const list = apiSettings.excludedWorldNames;
  const idx = list.indexOf(name);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(name);
}

/* —— 排除世界书条目:按条目名(comment)过滤,复刻清洗标签的输入框+chips。
   规则当正则,普通Tên即Bao gồm匹配;编译失败降级子串。 —— */
const wiPatternDraft = ref('');
function addWiPattern() {
  const pat = wiPatternDraft.value.trim();
  if (!pat) {
    wiPatternDraft.value = '';
    return;
  }
  if (!apiSettings.excludedWorldInfoPatterns.includes(pat)) apiSettings.excludedWorldInfoPatterns.push(pat);
  wiPatternDraft.value = '';
}
function removeWiPattern(pat: string) {
  const idx = apiSettings.excludedWorldInfoPatterns.indexOf(pat);
  if (idx >= 0) apiSettings.excludedWorldInfoPatterns.splice(idx, 1);
}

/* —— Nhãn làm sạch tùy chỉnh:用户填标签名(如 snow),清洗正文时把 <snow>…</snow> 整块删掉 —— */
const stripTagDraft = ref('');
function addStripTag() {
  const tag = sanitizeTagName(stripTagDraft.value);
  if (!tag) {
    stripTagDraft.value = '';
    return;
  }
  if (!apiSettings.customStripTags.includes(tag)) apiSettings.customStripTags.push(tag);
  stripTagDraft.value = '';
}
function removeStripTag(tag: string) {
  const idx = apiSettings.customStripTags.indexOf(tag);
  if (idx >= 0) apiSettings.customStripTags.splice(idx, 1);
}

// 点宏标签 → 插入到文本框光标处(Không có焦点则追加到末尾)
function insertMacro(token: string) {
  const el = promptArea.value;
  if (!el) {
    promptDraft.value += token;
    return;
  }
  const start = el.selectionStart ?? promptDraft.value.length;
  const end = el.selectionEnd ?? start;
  promptDraft.value = promptDraft.value.slice(0, start) + token + promptDraft.value.slice(end);
  // 等 v-model 回填后把光标移到插入内容之后
  void nextTick(() => {
    el.focus();
    const pos = start + token.length;
    el.setSelectionRange(pos, pos);
  });
}

/* —— Chi tiết triệu hồi lần trước(调试面板):纯只读展示 recallDebug,reactive 自动刷新 —— */
function fmtRecallTime(at: number): string {
  if (!at) return '';
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 来源 Q 标签:后端回传 -1(旧后端未支持)时显示占位符
function qLabel(queryIndex: number): string {
  return queryIndex >= 0 ? `Q${queryIndex + 1}` : '—';
}
const TIER_LABEL: Record<'full' | 'brief' | 'drop', string> = { full: 'Toàn văn', brief: 'Tóm tắt', drop: 'Loại bỏ' };
// 状态语气:决定横幅左侧圆点的配色(成功/警示/失败/进行中)
const recallStatusKind = computed<'ok' | 'warn' | 'fail' | 'pending'>(() => {
  const s = recallDebug.status;
  if (s.includes('Thất bại')) return 'fail';
  if (s.includes('Đang tiến hành')) return 'pending';
  if (s.includes('Chưa triệu hồi') || s.includes('Chưa chèn')) return 'warn';
  return 'ok';
});
// 分数(0~1)→ 进度条宽度百分比;负分(如未知)按 0 处理
function scorePct(score: number): number {
  return Math.max(0, Math.min(1, score)) * 100;
}
</script>

<template>
  <section class="bbs-page">
    <!-- 标题行右端显示版本号;Có更新时旁边出现「更新」按钮。 -->
    <div class="bbs-page-head">
      <h2 class="bbs-title bbs-title-sub">Cài đặt</h2>
      <div class="bbs-ver-row">
        <button
          class="bbs-ver"
          type="button"
          :disabled="updateState.checking"
          :title="updateState.checking ? 'Đang kiểm tra cập nhật' : 'Nhấn để kiểm tra cập nhật'"
          @click="checkForUpdate(true)"
        >
          v{{ updateState.current || '—' }}
        </button>
        <button
          v-if="updateState.available"
          class="bbs-btn bbs-btn-primary bbs-btn-sm"
          type="button"
          :disabled="updateState.updating"
          :title="`Cập nhật lên v${updateState.latest}`"
          @click="openUpdateConfirm"
        >
          {{ updateState.updating ? 'Đang cập nhật...' : 'Cập nhật' }}
        </button>
      </div>
    </div>
    <hr class="bbs-rule" />

    <!-- 总开关:整个插件的主控,Đóng即停止注入/摘要/总结/隐藏(已Có数据保留)。
         单独抬出在折叠区之上,作为这页最显眼的一处决策。 -->
    <div class="bbs-master" :class="{ 'is-off': !apiSettings.enabled }">
      <span class="bbs-master-spine" aria-hidden="true"></span>
      <div class="bbs-master-text">
        <span class="bbs-master-title">Bách Bảo Thư · Động cơ ký ức</span>
      </div>
      <button
        type="button"
        role="switch"
        class="bbs-toggle"
        :class="{ 'is-on': apiSettings.enabled }"
        :aria-checked="apiSettings.enabled"
        :title="apiSettings.enabled ? 'Nhấn để tắt' : 'Nhấn để bật'"
        @click="apiSettings.enabled = !apiSettings.enabled"
      >
        <span class="bbs-toggle-knob"></span>
      </button>
    </div>

    <div class="bbs-sections">
      <!-- Cài đặt cơ bản -->
      <Collapsible title="Cài đặt cơ bản" :open="false">
        <div class="bbs-field">
          <div class="bbs-field-head">
            <span class="bbs-field-label">Chủ đề</span>
          </div>
          <div class="bbs-segmented bbs-segmented-wrap">
            <button
              v-for="t in THEMES"
              :key="t.value"
              type="button"
              class="bbs-seg"
              :class="{ 'is-on': ui.theme === t.value }"
              @click="ui.theme = t.value"
            >
              <Icon :name="t.icon" />
              {{ t.label }}
            </button>
          </div>
        </div>

        <div class="bbs-field">
          <div class="bbs-field-head">
            <span class="bbs-field-label">Vị trí điều hướng</span>
          </div>
          <div class="bbs-segmented">
            <button
              v-for="n in navOptions"
              :key="n.value"
              type="button"
              class="bbs-seg"
              :class="{ 'is-on': ui.navPosition === n.value }"
              @click="ui.navPosition = n.value"
            >
              {{ n.label }}
            </button>
          </div>
        </div>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Thiết bị di động nhấn điều hướng đóng cửa sổ</span>
          <input v-model="ui.navTapClose" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">Trên thiết bị di động, nhấn thêm lần nữa vào nút điều hướng trang hiện tại sẽ đóng toàn bộ cửa sổ, không cần với lên nút × ở góc trên. Có thể tắt nếu sợ chạm nhầm.</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Hiển thị nút trên thanh đỉnh ST</span>
          <input v-model="ui.showTopBar" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">Thêm nút mở nhanh Bách Bảo Thư trên thanh điều hướng đỉnh quán trọ (bên trái quản lý thiết lập user), không cần nhấn đũa phép góc dưới bên trái mỗi lần. Lối vào đũa phép vẫn được giữ nguyên.</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Hiển thị nút phía trên khung trò chuyện</span>
          <input v-model="ui.showQuickReply" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">Thêm nút 'Bách Bảo Thư' phía trên khung nhập liệu (cùng vị trí trả lời nhanh), đổi kiểu theo chủ đề quán trọ.</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">Bật giao diện tầng</span>
          <input v-model="ui.showFloorPanel" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">Thêm giao diện dưới mỗi tầng AI: Xem tóm tắt và thay đổi dữ liệu của tầng đó, đánh dấu nhanh 'Ngoại truyện'. Tầng ngoại truyện sẽ bị hệ thống ký ức bỏ qua hoàn toàn (không tóm tắt, tổng kết hay chèn vào ngữ cảnh), thích hợp cho tiểu kịch trường/ngoại truyện; hủy đánh dấu để khôi phục.</p>

        <!-- Quả cầu lơ lửng màn hình:配置项多,收进可收缩小分组 -->
        <Collapsible title="Quả cầu lơ lửng màn hình" :open="false">
          <label class="bbs-switch-row">
            <span class="bbs-field-label">Hiển thị quả cầu lơ lửng trên màn hình</span>
            <input v-model="ui.showOrb" type="checkbox" class="bbs-checkbox" />
          </label>
          <p class="bbs-field-hint">Hiển thị quả cầu lơ lửng có thể kéo thả ở rìa màn hình, nhấn vào là mở Bách Bảo Thư. Kéo ra giữa để lơ lửng, kéo về cạnh trái/phải sẽ tự động bám cạnh.</p>

          <!-- 形状:仅开启时可配 -->
          <div v-if="ui.showOrb" class="bbs-field">
            <div class="bbs-field-head">
              <span class="bbs-field-label">Hình dạng</span>
            </div>
            <div class="bbs-segmented">
              <button
                v-for="s in ORB_SHAPES"
                :key="s.value"
                type="button"
                class="bbs-seg"
                :class="{ 'is-on': ui.orbShape === s.value }"
                @click="ui.orbShape = s.value"
              >
                {{ s.label }}
              </button>
            </div>
          </div>

          <!-- 静止透明度:仅开启时可配 -->
          <div v-if="ui.showOrb" class="bbs-field">
            <div class="bbs-field-head">
              <span class="bbs-field-label">Độ mờ khi đứng yên</span>
              <span class="bbs-field-value">{{ ui.orbOpacity }}%</span>
            </div>
            <input v-model.number="ui.orbOpacity" type="range" min="20" max="100" step="1" class="bbs-range" />
            <p class="bbs-field-hint">Độ mờ khi quả cầu đứng yên; sẽ hiển thị rõ hoàn toàn khi di chuột hoặc kéo thả.</p>
          </div>

          <!-- 大小:仅开启时可配 -->
          <div v-if="ui.showOrb" class="bbs-field">
            <div class="bbs-field-head">
              <span class="bbs-field-label">Kích thước</span>
              <span class="bbs-field-value">{{ ui.orbSize }}px</span>
            </div>
            <input v-model.number="ui.orbSize" type="range" min="32" max="80" step="1" class="bbs-range" />
          </div>

          <!-- 图标:仅开启时可配 -->
          <div v-if="ui.showOrb" class="bbs-orb-config">
            <div class="bbs-orb-preview" :class="[`shape-${ui.orbShape}`, { 'has-image': !!ui.orbImage }]">
              <img v-if="ui.orbImage" :src="ui.orbImage" alt="Xem trước biểu tượng quả cầu lơ lửng" />
              <Icon v-else name="bookmark" />
            </div>
            <div class="bbs-orb-config-actions">
              <button type="button" class="bbs-btn bbs-btn-sm bbs-btn-primary" :disabled="orbUploading" @click="pickOrbImage">
                {{ orbUploading ? 'Đang tải lên...' : ui.orbImage ? 'Đổi biểu tượng' : 'Tải biểu tượng' }}
              </button>
              <button v-if="ui.orbImage" type="button" class="bbs-btn bbs-btn-sm" @click="resetOrbImage">Khôi phục mặc định</button>
            </div>
            <input ref="orbFileInput" type="file" accept="image/*" hidden @change="onOrbFileChange" />
          </div>
          <p v-if="ui.showOrb" class="bbs-field-hint">Hỗ trợ ảnh tĩnh và ảnh động GIF (GIF giữ nguyên hoạt ảnh, ≤2MB). Biểu tượng được tải lên máy chủ quán trọ, đồng bộ qua các thiết bị; để trống sẽ dùng biểu tượng thẻ sách mặc định.</p>
        </Collapsible>
      </Collapsible>

      <!-- API phụ -->
      <Collapsible title="API phụ" :open="false">
        <!-- 任务指派 -->
        <div class="bbs-field bbs-assign">
          <label class="bbs-assign-row">
            <span class="bbs-field-label">Sử dụng cho tóm tắt</span>
            <select v-model="apiSettings.assignments.summary" class="bbs-input bbs-select">
              <option value="">Đi theo API chính</option>
              <option v-for="c in apiSettings.channels" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
          <label class="bbs-assign-row">
            <span class="bbs-field-label">Sử dụng cho tổng kết</span>
            <select v-model="apiSettings.assignments.resummary" class="bbs-input bbs-select">
              <option value="">Đi theo API chính</option>
              <option v-for="c in apiSettings.channels" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
        </div>
        <p class="bbs-field-hint">Khi không chỉ định kênh sẽ đi theo API chính: trực tiếp dùng API đang sử dụng trên giao diện chính (Hoàn thiện trò chuyện / Hoàn thiện văn bản) để tóm tắt, không cần cấu hình thêm. Nếu muốn dùng mô hình khác, hãy tạo kênh phụ bên dưới để chỉ định.</p>

        <hr class="bbs-rule" />

        <!-- Kênh:顶部Thêm按钮 + 紧凑只读列表(点行进弹窗编辑),不再一长列表单平铺 -->
        <div class="bbs-channel-bar">
          <span class="bbs-field-label">Kênh</span>
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addChannel('api')">
            <Icon name="plus" /> ThêmKênh
          </button>
        </div>

        <ul v-if="apiSettings.channels.length" class="bbs-channel-list">
          <li v-for="ch in apiSettings.channels" :key="ch.id" class="bbs-channel-item">
            <button class="bbs-channel-open" type="button" @click="openChannel(ch.id)">
              <span class="bbs-channel-item-name">{{ ch.name || 'Kênh chưa đặt tên' }}</span>
              <span class="bbs-channel-item-model">{{ ch.model || 'Chưa đặt mô hình' }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">Chưa có kênh nào. Nhấn 'Thêm kênh' để cấu hình API dùng cho tóm tắt/tổng kết.</p>
      </Collapsible>

      <!-- Cài đặt tóm tắt -->
      <Collapsible title="Cài đặt tóm tắt" :open="false">
        <label class="bbs-switch-row">
          <span class="bbs-field-label">Bật tự động tóm tắt</span>
          <input v-model="apiSettings.autoSummaryEnabled" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">Bật để tự động tóm tắt và ẩn tầng cũ, đồng thời bật nhãn thời gian cốt truyện (mốc thời gian) và chặn tồn đọng (chặn gửi và nhắc bổ sung khi sót tóm tắt).</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Khung số chữ</span>
          <select v-model="apiSettings.verbosity" class="bbs-input bbs-select bbs-select-narrow">
            <option value="detailed">Chi tiết</option>
            <option value="concise">Tinh gọn</option>
          </select>
        </label>
        <p class="bbs-field-hint">Điều chỉnh nhanh số chữ mục tiêu cho Tóm tắt/Tổng kết/Tổng kết cấp hai. Chi tiết = Đầy đủ thông tin (Tóm tắt 150-300, Tổng kết 300-500 chữ); Tinh gọn = Tiết kiệm token (Tóm tắt 80-150, Tổng kết 150-300 chữ). Chỉ ảnh hưởng lời nhắc tích hợp, không ảnh hưởng mẫu tùy chỉnh.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Số tin nhắn AI gần đây giữ lại</span>
          <input v-model.number="apiSettings.keepRecent" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">Giữ lại ngần này tin nhắn AI gửi toàn văn, phần vượt quá sẽ tự động ẩn và gửi tóm tắt.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Số tin nhắn AI mỗi lần tổng kết</span>
          <input v-model.number="apiSettings.leafBatchThreshold" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">Mỗi lần tổng kết ngần này tóm tắt, không tính tầng user, 0 là tắt tự động tổng kết.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Tổng kết cấp hai</span>
          <input v-model.number="apiSettings.resummaryThreshold" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">Khi đạt ngần này tổng kết sẽ tiến hành tổng kết cấp hai, 0 là tắt tổng kết cấp hai.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Đính kèm kế hoạch gần đây đã hoàn thành</span>
          <input v-model.number="apiSettings.recentResolvedPlansCount" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">Đính kèm 'Kế hoạch/Huyền niệm đã hoàn thành' vào bản sao lưu trạng thái, nhắc AI không thúc đẩy hay ghi lặp lại những việc vừa giải quyết; đính kèm đồng thời vào cả mô hình chính và API phụ tóm tắt. Lấy tối đa ngần này mục gần nhất cho kế hoạch và huyền niệm (ví dụ điền 5 = tối đa 5 kế hoạch + 5 huyền niệm). 0 là không đính kèm, mặc định là 5.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Số lần thử lại khi thất bại</span>
          <input v-model.number="apiSettings.summaryMaxRetries" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">Số lần thử lại tối đa khi yêu cầu tóm tắt/tổng kết thất bại (báo lỗi hoặc không phân tích được nội dung), 0 là không thử lại. Mặc định 1.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Bổ sung hàng loạt · Số chữ mỗi lô</span>
          <input v-model.number="apiSettings.batchMaxChars" class="bbs-input bbs-num" type="number" min="500" step="500" />
        </label>
        <p class="bbs-field-hint">Khi bổ sung tóm tắt hàng loạt, mỗi yêu cầu gom tối đa ngần này chữ (sau khi làm sạch) thì chia lô. Càng lớn càng tiết kiệm token/càng nhanh, nhưng quá lớn sẽ khiến AI phân tâm, giảm chất lượng. Mặc định 30000.</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">Bổ sung hàng loạt · Giới hạn số tầng mỗi lô</span>
          <input v-model.number="apiSettings.batchMaxFloors" class="bbs-input bbs-num" type="number" min="1" />
        </label>
        <p class="bbs-field-hint">Khi số chữ chưa đạt giới hạn, đạt số tầng này cũng chia lô, làm phương án dự phòng. Mặc định 10.</p>
      </Collapsible>

      <!-- Loại trừ nhân vật -->
      <Collapsible title="Loại trừ nhân vật" :open="false">
        <p class="bbs-field-hint">Trong cuộc trò chuyện có tên nhân vật được chọn (bao gồm thẻ trùng tên), toàn bộ tính năng của Bách Bảo Thư sẽ không kích hoạt —— không tóm tắt, không ẩn, không chèn, không chặn. Thích hợp cho các thẻ công cụ, không cần ghi nhớ.</p>
        <div class="bbs-channel-bar">
          <span class="bbs-field-label">
            Đã loại trừ {{ apiSettings.excludedChars.length }} nhân vật
          </span>
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="openExclude">
            <Icon name="edit" /> Chỉnh sửa danh sách
          </button>
        </div>
        <ul v-if="apiSettings.excludedChars.length" class="bbs-exclude-chips">
          <li v-for="name in apiSettings.excludedChars" :key="name" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">{{ name }}</span>
            <button class="bbs-exclude-chip-x" type="button" title="Xóa khỏi danh sách" @click="toggleExcluded(name)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">Danh sách trống, toàn bộ nhân vật đều kích hoạt hệ thống ký ức.</p>
      </Collapsible>

      <!-- Loại trừ nội dung thế giới thư -->
      <Collapsible title="Loại trừ nội dung thế giới thư" :open="false">
        <p class="bbs-field-hint">
          Khi tóm tắt/tổng kết sẽ kích hoạt Thế giới thư làm tài liệu tham khảo. Tại đây bạn có thể loại bỏ các mục không hữu ích cho ký ức cốt truyện —— chẳng hạn như Kiến thức bổ sung, giải thích quy tắc gắn toàn cục..., vừa tiết kiệm token vừa tránh nhiễu. Chỉ ảnh hưởng đến API phụ tóm tắt, không làm thay đổi Thế giới thư trong cuộc trò chuyện chính của bạn.
        </p>

        <!-- Kết xuất mẫu Thế giới thư: phối hợp với plugin ST-Prompt-Template -->
        <label class="bbs-switch-row">
          <span class="bbs-field-label">Kết xuất mẫu Thế giới thư</span>
          <input v-model="apiSettings.renderWorldInfoTemplates" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">
          Khi bật, trước khi đọc bài Thế giới thư hệ thống sẽ mở rộng <code v-pre>{{macro}}</code> và thực thi EJS (<code>&lt;% %&gt;</code>) của plugin <strong>ST-Prompt-Template</strong>, giúp các mục động (như tự đổi thái độ theo độ hảo cảm) nhận được <strong>văn bản thành phẩm sau khi thực thi</strong> thay vì nguyên văn code. Khi chưa cài plugin ST-Prompt-Template sẽ chỉ mở rộng macro.
          <br />
          ⚠️ Nếu lệnh EJS trong Thế giới thư có chứa thao tác <strong>ghi/thay đổi biến</strong> (như <code>setvar</code>), mỗi lần tóm tắt sẽ chạy lệnh thêm một lần và có thể làm sai lệch biến số. Hãy tắt mục này nếu bộ sách của bạn gặp trường hợp đó.
        </p>

        <!-- 整本排除:复刻Loại trừ nhân vật的搜索+勾选弹窗 -->
        <div class="bbs-channel-bar">
          <span class="bbs-field-label">Loại trừ nguyên bộ · Đã chọn {{ apiSettings.excludedWorldNames.length }} bộ</span>
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="openExcludeWorld">
            <Icon name="edit" /> Chỉnh sửa danh sách
          </button>
        </div>
        <ul v-if="apiSettings.excludedWorldNames.length" class="bbs-exclude-chips">
          <li v-for="name in apiSettings.excludedWorldNames" :key="name" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">{{ name }}</span>
            <button class="bbs-exclude-chip-x" type="button" title="Xóa khỏi danh sách" @click="toggleWorldExcluded(name)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">Chưa loại trừ thế giới thư nào, toàn bộ mục kích hoạt sẽ được đưa vào tham khảo tóm tắt.</p>

        <hr class="bbs-rule" />

        <!-- Lọc theo tên mục:复刻清洗标签的输入框 + chips -->
        <div class="bbs-field-head">
          <span class="bbs-field-label">Lọc theo tên mục</span>
        </div>
        <p class="bbs-field-hint">
          Điền tên ghi chú (comment) của mục sẽ khớp theo kiểu <strong>Chứa</strong> (không phân biệt hoa thường) —— ví dụ điền <code>Bổ sung</code> sẽ khớp các mục như "Thiết lập Bổ sung". Cũng hỗ trợ biểu thức chính quy: <code>^Quy_tắc</code> nghĩa là bắt đầu bằng từ "Quy_tắc". Áp dụng cho các quyển Thế giới thư chưa bị loại trừ toàn bộ ở trên. Mặc định thiết lập sẵn một dòng <code>\[mvu[\s\S]*?\]</code>, lọc các mục cơ chế của khung Biến số MVU; nếu không cần bạn có thể xóa trực tiếp.
        </p>
        <div class="bbs-striptag-bar">
          <input
            v-model="wiPatternDraft"
            class="bbs-input"
            type="text"
            placeholder="Tên mục hoặc regex, ví dụ Phụ trợ hoặc ^Quy_tắc"
            @keydown.enter.prevent="addWiPattern"
          />
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addWiPattern">
            <Icon name="plus" /> Thêm
          </button>
        </div>
        <ul v-if="apiSettings.excludedWorldInfoPatterns.length" class="bbs-exclude-chips">
          <li v-for="pat in apiSettings.excludedWorldInfoPatterns" :key="pat" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">{{ pat }}</span>
            <button class="bbs-exclude-chip-x" type="button" title="Xóa bỏ" @click="removeWiPattern(pat)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">Chưa có quy tắc tên mục.</p>
      </Collapsible>

      <!-- Nhãn làm sạch tùy chỉnh -->
      <Collapsible title="Nhãn làm sạch tùy chỉnh" :open="false">
        <p class="bbs-field-hint">
          Nếu trong văn bản cốt truyện có lẫn các khối định dạng do plugin khác / thế giới thư viết (như thanh trạng thái <code>&lt;snow&gt;…&lt;/snow&gt;</code>), bạn có thể điền tên thẻ vào đây (chỉ điền <code>snow</code>, không kèm dấu ngoặc nhọn), khi tóm tắt, lập chỉ mục vector và triệu hồi sẽ xóa toàn bộ khối cùng nội dung bên trong. Sau khi điều chỉnh sẽ có hiệu lực ngay lập tức cho **triệu hồi** (kho vector lưu nguyên văn, khi triệu hồi mới làm sạch), không cần tái lập chỉ mục.
        </p>
        <div class="bbs-striptag-bar">
          <input
            v-model="stripTagDraft"
            class="bbs-input"
            type="text"
            placeholder="Tên nhãn, ví dụ snow"
            @keydown.enter.prevent="addStripTag"
          />
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addStripTag">
            <Icon name="plus" /> Thêm
          </button>
        </div>
        <ul v-if="apiSettings.customStripTags.length" class="bbs-exclude-chips">
          <li v-for="tag in apiSettings.customStripTags" :key="tag" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">&lt;{{ tag }}&gt;</span>
            <button class="bbs-exclude-chip-x" type="button" title="Xóa bỏ" @click="removeStripTag(tag)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">Chưa có nhãn tùy chỉnh. Chỉ làm sạch tích hợp (chuỗi suy nghĩ, ghi chú, chú giải vật phẩm...) có hiệu lực.</p>
      </Collapsible>

      <!-- Lời nhắc tùy chỉnh -->
      <Collapsible title="Lời nhắc tùy chỉnh" :open="false">
        <ul class="bbs-prompt-list">
          <li v-for="m in PROMPT_METAS" :key="m.key" class="bbs-prompt-item">
            <button class="bbs-prompt-open" type="button" @click="openPrompt(m)">
              <span class="bbs-prompt-name">{{ m.label }}</span>
              <span class="bbs-prompt-state" :class="{ 'is-custom': isCustom(m.key) }">
                {{ isCustom(m.key) ? 'Đã tùy chỉnh' : 'Mặc định' }}
              </span>
              <Icon name="edit" class="bbs-prompt-edit" />
            </button>
          </li>
        </ul>
      </Collapsible>

      <!-- Ký ức vectơ -->
      <Collapsible title="Ký ức vectơ" :open="false">
        <label class="bbs-switch-row bbs-vec-enable">
          <span class="bbs-field-label">Bật ký ức vectơ</span>
          <input v-model="apiSettings.vector.enabled" type="checkbox" class="bbs-checkbox" />
        </label>

        <hr class="bbs-rule bbs-vec-enable-rule" />

        <!-- 三个端点:Embedding 必填;Rerank/Query 地址留空 = 整体复用 Embedding。
             卡片自身可折叠(点标题栏),Không có额外外框;副标显当前Mô hình,收起也看得出配没配。 -->
        <div
          v-for="role in VECTOR_ROLES"
          :key="role.key"
          class="bbs-vec-ep"
          :class="{ 'is-disabled': !apiSettings.vector.enabled, 'is-collapsed': !vecEpOpen[role.key] }"
        >
          <button
            type="button"
            class="bbs-vec-head bbs-vec-toggle"
            :aria-expanded="vecEpOpen[role.key]"
            @click="vecEpOpen[role.key] = !vecEpOpen[role.key]"
          >
            <span class="bbs-field-label">{{ role.label }}</span>
            <Icon name="chevron" class="bbs-vec-chevron" />
          </button>

          <div class="bbs-vec-ep-outer">
            <div class="bbs-vec-ep-inner">
          <div class="bbs-vec-ep-body">
          <p v-if="role.key !== 'embedding'" class="bbs-field-hint">Để trống địa chỉ / khóa sẽ dùng lại Embedding; mô hình vẫn cần điền riêng.</p>

          <label class="bbs-modal-field">
            <span class="bbs-modal-label">Địa chỉ API</span>
            <input
              v-model="apiSettings.vector[role.key].url"
              class="bbs-input"
              :placeholder="role.key === 'embedding' ? 'Ví dụ: https://api.openai.com/v1' : 'Để trống = dùng lại địa chỉ Embedding'"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>

          <label class="bbs-modal-field">
            <span class="bbs-modal-label">Khóa API</span>
            <div class="bbs-model-row">
              <input
                v-model="apiSettings.vector[role.key].key"
                class="bbs-input"
                :type="vecShowKey[role.key] ? 'text' : 'password'"
                :placeholder="role.key === 'embedding' ? 'Khóa API' : 'Để trống = dùng lại khóa Embedding'"
                :disabled="!apiSettings.vector.enabled"
              />
              <button
                class="bbs-icon-mini"
                type="button"
                :title="vecShowKey[role.key] ? 'Ẩn khóa' : 'Hiện khóa'"
                @click="vecShowKey[role.key] = !vecShowKey[role.key]"
              >
                <Icon :name="vecShowKey[role.key] ? 'eye-off' : 'eye'" />
              </button>
            </div>
          </label>

          <!-- Mô hình:三个Nhân vật各自独立(embedding/rerank/query Mô hình本就不同),都要单独选,从不复用。
               拉取走「该Nhân vật的地址/密钥」,留空则自动用 Embedding 的地址/密钥去拉。 -->
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">Mô hình</span>
            <div class="bbs-model-row">
              <div class="bbs-combo">
                <input
                  v-model="apiSettings.vector[role.key].model"
                  class="bbs-input"
                  :placeholder="(vecModels[role.key]?.length) ? 'Tìm kiếm hoặc nhập tên mô hình...' : 'Tên mô hình, hoặc nhấn bên phải để tải'"
                  :disabled="!apiSettings.vector.enabled"
                  @focus="openVecModelMenu(role.key)"
                  @input="vecModelQuery = apiSettings.vector[role.key].model; vecModelMenuOpen = role.key"
                  @blur="closeVecModelMenuSoon"
                />
                <span
                  v-if="vecModels[role.key]?.length"
                  class="bbs-combo-caret"
                  :class="{ 'is-open': vecModelMenuOpen === role.key }"
                  aria-hidden="true"
                />
                <ul v-if="vecModelMenuOpen === role.key && vecModels[role.key]?.length" class="bbs-combo-menu">
                  <li v-if="!filteredVecModels(role.key).length" class="bbs-combo-empty">Không có mô hình khớp</li>
                  <li
                    v-for="m in filteredVecModels(role.key)"
                    :key="m"
                    class="bbs-combo-item"
                    :class="{ 'is-active': m === apiSettings.vector[role.key].model }"
                    @mousedown.prevent="pickVecModel(role.key, m)"
                  >
                    {{ m }}
                  </li>
                </ul>
              </div>
              <button
                class="bbs-icon-mini"
                type="button"
                :title="vecLoadingModels[role.key] ? 'Đang tải...' : 'Tải danh sách mô hình'"
                :disabled="!apiSettings.vector.enabled || vecLoadingModels[role.key]"
                @click="pullVecModels(role.key)"
              >
                <Icon name="refresh" />
              </button>
            </div>
          </label>
          <p v-if="vecModelMsg[role.key]" class="bbs-field-hint">{{ vecModelMsg[role.key] }}</p>

          <!-- 超时/重试:各Nhân vật独立(Mặc định embedding 10s / rerank 20s / query 90s),不随地址复用回落。 -->
          <div class="bbs-vec-io">
            <label class="bbs-vec-io-item">
              <span class="bbs-modal-label">Thời gian chờ (giây)</span>
              <input
                v-model.number="apiSettings.vector[role.key].timeoutSec"
                class="bbs-input bbs-num-sm"
                type="number"
                min="1"
                :disabled="!apiSettings.vector.enabled"
              />
            </label>
            <label class="bbs-vec-io-item">
              <span class="bbs-modal-label">Số lần thử lại khi thất bại</span>
              <input
                v-model.number="apiSettings.vector[role.key].retries"
                class="bbs-input bbs-num-sm"
                type="number"
                min="0"
                :disabled="!apiSettings.vector.enabled"
              />
            </label>
          </div>
          </div>
            </div>
          </div>
        </div>

        <hr class="bbs-rule" />

        <!-- Tham số triệu hồi:机制说明 + 进阶旋钮整体折叠,Mặc định收起,不淹没上方端点配置。 -->
        <Collapsible title="Tham số triệu hồi" :open="false">
          <div class="bbs-vec-recall" :class="{ 'is-disabled': !apiSettings.vector.enabled }">
            <p class="bbs-field-hint">
              Trước tiên tính độ tương đồng embedding cho toàn bộ chỉ mục vector, lấy số lượng mục có điểm cao nhất đưa vào xếp hạng lại (rerank); sau khi rerank chấm điểm sẽ chia hai mức: điểm cao sẽ gửi toàn bộ nguyên văn, điểm thấp hơn một chút nhưng vẫn vượt ngưỡng embedding sẽ gửi bản tóm tắt; tổng hai mức không vượt quá "Số mục triệu hồi tối đa".
            </p>

            <p class="bbs-field-hint">
              Trước khi tạo câu trả lời, dùng mô hình nhỏ (phần "Viết lại truy vấn" ở trên) viết lại tình tiết hiện tại thành nhiều truy vấn tìm kiếm, giúp triệu hồi đa luồng toàn diện hơn.
              <strong>Viết lại truy vấn là bước bắt buộc của triệu hồi, cần cấu hình mô hình 'Viết lại truy vấn'; nếu không cấu hình hoặc viết lại thất bại thì lượt này không triệu hồi.</strong>
              Mỗi hiệp sẽ thêm một lần gọi mô hình nhỏ (tăng nhẹ độ trễ).
            </p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Số ứng viên Rerank</span>
            <input
              v-model.number="apiSettings.vector.recall.rerankCandidates"
              class="bbs-input bbs-num"
              type="number"
              min="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">Lấy N mục đầu tiên theo độ tương đồng embedding để đưa vào rerank tinh lọc (càng lớn càng chuẩn nhưng càng chậm).</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Ngưỡng Embedding</span>
            <input
              v-model.number="apiSettings.vector.recall.embeddingThreshold"
              class="bbs-input bbs-num"
              type="number"
              step="0.01"
              min="0"
              max="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">Ngưỡng nhận tóm tắt: nội dung có độ tương đồng embedding thấp hơn ngưỡng này sẽ không được triệu hồi (0~1).</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Ngưỡng Rerank</span>
            <input
              v-model.number="apiSettings.vector.recall.rerankThreshold"
              class="bbs-input bbs-num"
              type="number"
              step="0.01"
              min="0"
              max="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">Điểm rerank ≥ giá trị này sẽ gửi nguyên văn, thấp hơn ngưỡng này nhưng vượt ngưỡng embedding sẽ lùi về gửi tóm tắt (0~1).</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Số toàn văn triệu hồi</span>
            <input
              v-model.number="apiSettings.vector.recall.fullTextCount"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">Lấy tối đa ngần này mục toàn văn để gửi nguyên văn (phần còn lại dù vượt ngưỡng rerank cũng lùi về tóm tắt).</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Số mục triệu hồi cuối cùng</span>
            <input
              v-model.number="apiSettings.vector.recall.finalRecallCount"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">Giới hạn tổng số mục triệu hồi (tổng toàn văn + tóm tắt); toàn văn không đủ thì bù bằng tóm tắt, không đầy cũng không sao.</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Số tầng AI bắt đầu triệu hồi</span>
            <input
              v-model.number="apiSettings.vector.recall.minAiFloors"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">
            Khi số tin nhắn AI trong cuộc trò chuyện hiện tại ít hơn giá trị này sẽ không kích hoạt triệu hồi (0 = không giới hạn). Ở giai đoạn đầu cốt truyện ký ức cũ còn ít, bỏ qua sẽ giúp tiết kiệm hạn mức/độ trễ. Ngoài ra: khi toàn bộ tin nhắn vẫn đang nằm trong cửa sổ gửi nguyên văn thì cũng tự động bỏ qua (vì không có lầu cũ ngoài cửa sổ để triệu hồi); bản lưu cũ từ "Tạo hội thoại mới kèm dữ liệu" không bị giới hạn này, luôn triệu hồi.
          </p>
          </div>
        </Collapsible>

        <hr class="bbs-rule" />

        <!-- Bảo trì chỉ mục:把当前聊天的叶子摘要补建/对账进向量库 -->
        <div class="bbs-vec-recall" :class="{ 'is-disabled': !apiSettings.vector.enabled }">
          <div class="bbs-vec-head">
            <span class="bbs-field-label">Bảo trì chỉ mục</span>
            <span
              v-if="vecBackend !== 'unknown'"
              class="bbs-vec-backend"
              :class="vecBackend === 'backend' ? 'is-backend' : 'is-local'"
            >
              {{ vecBackend === 'backend' ? 'Bách Bảo Khố' : 'Giao diện (Frontend)' }}
            </span>
          </div>
          <p class="bbs-field-hint">
            Trong trường hợp bình thường, tóm tắt nút lá sẽ tự động lập chỉ mục khi tạo câu trả lời; nếu giữa chừng mới bật Ký ức vector, bạn có thể thủ công lập chỉ mục bổ sung cho các bản tóm tắt hiện có trong cuộc trò chuyện vào kho vector. Việc xóa trắng chỉ xóa chỉ mục của cuộc trò chuyện hiện tại, không đụng chạm đến bản chụp dữ liệu cũ kế thừa từ "Tạo hội thoại mới kèm dữ liệu".
          </p>
          <p v-if="vecBackend === 'local'" class="bbs-field-hint">
            Chế độ cục bộ: chỉ mục lưu trong trình duyệt, chỉ triệu hồi cho cuộc trò chuyện hiện tại, không liên thông giữa các cuộc trò chuyện / không đồng bộ giữa các thiết bị. Sau khi cài đặt backend Bách Bảo Khố có thể khôi phục đầy đủ tính năng.
          </p>
          <div class="bbs-vec-index-actions">
            <button
              class="bbs-btn bbs-btn-sm"
              type="button"
              :disabled="!apiSettings.vector.enabled || vecIndexing || vecClearing"
              @click="doRebuildIndex"
            >
              {{ vecIndexing ? 'Đang tạo chỉ mục...' : 'Tái tạo chỉ mục vectơ cho trò chuyện hiện tại' }}
            </button>
            <button
              class="bbs-btn bbs-btn-sm bbs-btn-danger"
              type="button"
              :disabled="!apiSettings.vector.enabled || vecIndexing || vecClearing"
              @click="doClearIndex"
              @blur="vecClearConfirm = false"
            >
              <Icon name="trash" />
              {{ vecClearing ? 'Đang xóa trống...' : vecClearConfirm ? 'Nhấn lần nữa để xác nhận xóa' : 'Xóa trống chỉ mục trò chuyện hiện tại' }}
            </button>
          </div>
          <p v-if="vecIndexMsg" class="bbs-field-hint">{{ vecIndexMsg }}</p>
        </div>

        <hr class="bbs-rule" />

        <!-- Chi tiết triệu hồi lần trước:把上一次召回各阶段的中间结果可视化,便于调参/排障(reactive 自动刷新) -->
        <Collapsible title="Chi tiết triệu hồi lần trước" :open="false">
          <p v-if="!recallDebug.at" class="bbs-field-hint">
            Chưa có nhật ký triệu hồi. Sau khi cấu hình xong kênh vector, hãy gửi một tin nhắn để kích hoạt triệu hồi, kết quả các giai đoạn viết lại / tìm kiếm / xếp hạng lại / tiêm dữ liệu sẽ hiển thị tại đây.
          </p>
          <div v-else class="bbs-dbg">
            <!-- 状态横幅:左侧圆点按语气配色,右侧Thời gian -->
            <div class="bbs-dbg-banner" :class="`is-${recallStatusKind}`">
              <span class="bbs-dbg-dot" aria-hidden="true"></span>
              <span class="bbs-dbg-status-text">{{ recallDebug.status }}</span>
              <span class="bbs-dbg-time">{{ fmtRecallTime(recallDebug.at) }}</span>
            </div>

            <!-- 四阶段各自可折叠,Mặc định收起;标题带计数 -->
            <Collapsible :title="`1 · Viết lại truy vấn · ${recallDebug.queries.length} Q`" :open="false">
              <p v-if="recallDebug.intent" class="bbs-dbg-intent">
                <span class="bbs-dbg-tag">INTENT</span><span class="bbs-dbg-intent-text">{{ recallDebug.intent }}</span>
              </p>
              <ul v-if="recallDebug.queries.length" class="bbs-dbg-qlist">
                <li v-for="(q, i) in recallDebug.queries" :key="i" class="bbs-dbg-qitem">
                  <span class="bbs-dbg-qno">Q{{ i + 1 }}</span><span class="bbs-dbg-qtext">{{ q }}</span>
                </li>
              </ul>
              <p v-else class="bbs-dbg-empty">Không có</p>
            </Collapsible>

            <Collapsible :title="`2 · Tìm kiếm Embedding · ${recallDebug.embedding.length} mục`" :open="false">
              <ul v-if="recallDebug.embedding.length" class="bbs-dbg-cards">
                <li v-for="(h, i) in recallDebug.embedding" :key="i" class="bbs-dbg-card">
                  <div class="bbs-dbg-card-top">
                    <span class="bbs-dbg-src" :title="`Nguồn ${qLabel(h.queryIndex)}`">{{ qLabel(h.queryIndex) }}</span>
                    <span class="bbs-dbg-from" :class="{ 'is-bundle': h.source === 'Hồ sơ cũ' }">{{ h.source }}</span>
                    <span v-if="h.storyTime" class="bbs-dbg-when">【{{ h.storyTime }}】</span>
                    <span class="bbs-dbg-num">{{ h.similarity.toFixed(3) }}</span>
                  </div>
                  <div class="bbs-dbg-bar"><i :style="{ width: scorePct(h.similarity) + '%' }"></i></div>
                  <p class="bbs-dbg-prev">{{ h.preview }}</p>
                </li>
              </ul>
              <p v-else class="bbs-dbg-empty">Không có</p>
            </Collapsible>

            <Collapsible :title="`3 · Sắp xếp Rerank · ${recallDebug.rerank.length} mục`" :open="false">
              <ul v-if="recallDebug.rerank.length" class="bbs-dbg-cards">
                <li v-for="(h, i) in recallDebug.rerank" :key="i" class="bbs-dbg-card" :class="{ 'is-dropped': h.tier === 'drop' }">
                  <div class="bbs-dbg-card-top">
                    <span class="bbs-dbg-tier" :class="`is-${h.tier}`">{{ TIER_LABEL[h.tier] }}</span>
                    <span class="bbs-dbg-from" :class="{ 'is-bundle': h.source === 'Hồ sơ cũ' }">{{ h.source }}</span>
                    <span v-if="h.storyTime" class="bbs-dbg-when">【{{ h.storyTime }}】</span>
                    <span class="bbs-dbg-num">{{ h.rerankScore.toFixed(3) }}</span>
                  </div>
                  <div class="bbs-dbg-bar" :class="`tier-${h.tier}`"><i :style="{ width: scorePct(h.rerankScore) + '%' }"></i></div>
                  <p class="bbs-dbg-prev">{{ h.preview }}</p>
                </li>
              </ul>
              <p v-else class="bbs-dbg-empty">Không có (chưa thực hiện rerank hoặc không có ứng viên)</p>
            </Collapsible>

            <Collapsible title="4 · Chèn cuối cùng" :open="false">
              <pre v-if="recallDebug.injectedText" class="bbs-dbg-pre">{{ recallDebug.injectedText }}</pre>
              <p v-else class="bbs-dbg-empty">Lượt này chưa chèn.</p>
            </Collapsible>
          </div>
        </Collapsible>
      </Collapsible>

      <!-- Tạo đối thoại mới kèm dữ liệu -->
      <Collapsible title="Tạo đối thoại mới kèm dữ liệu" :open="false">
        <p class="bbs-field-hint">
          Đóng gói "cửa sổ nguyên văn gần nhất + Tóm tắt lịch sử gộp + Trạng thái hiện tại (Thời gian/Địa điểm, khung cảnh, vật phẩm, nhân vật, kế hoạch, biến số)" của cuộc trò chuyện hiện tại để tạo một cuộc trò chuyện mới mang theo sang. Cuộc trò chuyện mới sẽ phát lại từ một "nút lá hạt giống" để khôi phục trạng thái, cốt truyện cũ đi kèm dưới dạng tóm tắt; nếu đã bật Ký ức vector, cuộc trò chuyện cũ sẽ được chụp lại bản sao, cuộc trò chuyện mới có thể triệu hồi vector nội dung từ đó (tích lũy qua từng lần, các nhánh cũng tự động kế thừa).
        </p>
        <div v-if="carryPlan" class="bbs-field-hint">
          Sẽ mang theo: {{ carryPlan.aiCount }} tin nhắn AI / {{ carryPlan.carryCount }} tin nhắn thực tế; tóm tắt cốt truyện cũ: {{ carryPlan.recapLen > 0 ? 'Có' : 'Không có' }}.
        </div>
        <button
          class="bbs-btn bbs-btn-sm bbs-btn-primary"
          type="button"
          :disabled="carrying || !carryPlan?.hasData"
          @click="carryConfirmOpen = true"
        >
          {{ carrying ? 'Đang tạo mới...' : 'Tạo đối thoại mới kèm dữ liệu' }}
        </button>
        <p v-if="carryMsg" class="bbs-field-hint">{{ carryMsg }}</p>
      </Collapsible>

      <!-- Di chuyển từ bản cũ Horae -->
      <Collapsible title="Di chuyển từ bản cũ Horae" :open="false">
        <p class="bbs-field-hint">
          Di chuyển tóm tắt, vật phẩm, kế hoạch từ phiên bản Horae cũ trong cuộc trò chuyện hiện tại sang. Các cuộc trò chuyện cần di chuyển hãy bấm nút một lần, thao tác này không làm thay đổi dữ liệu gốc của Horae.
        </p>
        <div v-if="migratePlan" class="bbs-field-hint">
          <template v-if="migratePlan.hasData">
            Phát hiện: có thể tạo tóm tắt {{ migratePlan.leafFloors }} tầng / {{ migratePlan.summaryCount }} bản tổng kết cũ / {{ migratePlan.itemCount }} vật phẩm / {{ migratePlan.planCount }} kế hoạch & huyền niệm.
            <span v-if="migratePlan.willOverwrite">⚠️ Cuộc trò chuyện hiện tại đã có dữ liệu của tiện ích này, di chuyển sẽ ghi đè.</span>
          </template>
          <template v-else>Không phát hiện dữ liệu cũ Horae trong cuộc trò chuyện hiện tại (vui lòng mở cuộc trò chuyện chứa dữ liệu cũ).</template>
        </div>
        <button
          class="bbs-btn bbs-btn-sm bbs-btn-primary"
          type="button"
          :disabled="migrating || !migratePlan?.hasData"
          @click="migrateConfirmOpen = true"
        >
          {{ migrating ? 'Đang di chuyển...' : 'Di chuyển dữ liệu Horae của cuộc trò chuyện hiện tại' }}
        </button>
        <p v-if="migrateMsg" class="bbs-field-hint">{{ migrateMsg }}</p>
      </Collapsible>
    </div>

    <!-- Tạo đối thoại mới kèm dữ liệu / Horae 迁移 的确认弹窗 -->
    <ConfirmDialog
      v-model:open="carryConfirmOpen"
      title="Tạo đối thoại mới kèm dữ liệu"
      confirm-text="Tạo mới và chuyển sang"
      @confirm="runCarryover"
    >
      Sẽ tạo một cuộc trò chuyện mới kèm dữ liệu dựa trên cuộc trò chuyện hiện tại và chuyển sang đó. Bạn có muốn tiếp tục không?
    </ConfirmDialog>
    <ConfirmDialog
      v-model:open="migrateConfirmOpen"
      title="Di chuyển từ bản cũ Horae"
      confirm-text="Bắt đầu di chuyển"
      @confirm="runMigrate"
    >
      {{ migrateConfirmText }}
    </ConfirmDialog>

    <!-- ===== Kênh编辑弹窗 ===== -->
    <ModalMask :open="!!editingChannel" @close="closeChannel">
      <div v-if="editingChannel" class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa kênh">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Chỉnh sửa kênh</span>
          <button class="bbs-icon-mini" type="button" title="Đóng" @click="closeChannel"><Icon name="close" /></button>
        </header>

        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tên kênh</span>
          <input v-model="editingChannel.name" class="bbs-input" placeholder="Tên kênh" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Địa chỉ API</span>
          <input v-model="editingChannel.url" class="bbs-input" placeholder="Ví dụ: https://api.openai.com/v1" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Khóa API</span>
          <div class="bbs-model-row">
            <input
              v-model="editingChannel.key"
              class="bbs-input"
              :type="showKey ? 'text' : 'password'"
              placeholder="Khóa API"
            />
            <button
              class="bbs-icon-mini"
              type="button"
              :title="showKey ? 'Ẩn khóa' : 'Hiện khóa'"
              :aria-pressed="showKey"
              @click="showKey = !showKey"
            >
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Mô hình</span>
          <div class="bbs-model-row">
            <!-- 可搜索 combobox:已拉取到Mô hình列表时,聚焦弹出过滤菜单;没列表时就是普通输入框 -->
            <div class="bbs-combo">
              <input
                v-model="editingChannel.model"
                class="bbs-input"
                :placeholder="modelList.length ? 'Tìm hoặc nhập tên mô hình...' : 'Tên mô hình, ví dụ gpt-4o-mini'"
                @focus="openModelMenu"
                @input="modelQuery = editingChannel.model; modelMenuOpen = true"
                @blur="closeModelMenuSoon"
              />
              <!-- 自绘下拉三角(纯装饰,pointer-events:none → 点击穿透到输入框照常聚焦展开);仅在Có可选Mô hình时显示 -->
              <span v-if="modelList.length" class="bbs-combo-caret" :class="{ 'is-open': modelMenuOpen }" aria-hidden="true" />
              <ul v-if="modelMenuOpen && modelList.length" class="bbs-combo-menu">
                <li v-if="!filteredModels.length" class="bbs-combo-empty">Không có mô hình khớp</li>
                <li
                  v-for="m in filteredModels"
                  :key="m"
                  class="bbs-combo-item"
                  :class="{ 'is-active': m === editingChannel.model }"
                  @mousedown.prevent="pickModel(m)"
                >
                  {{ m }}
                </li>
              </ul>
            </div>
            <button
              class="bbs-icon-mini"
              type="button"
              :title="loadingModels[editingChannel.id] ? 'Đang tải...' : 'Tải danh sách mô hình'"
              :disabled="loadingModels[editingChannel.id]"
              @click="pullModels(editingChannel)"
            >
              <Icon name="refresh" />
            </button>
          </div>
        </label>
        <div class="bbs-channel-row">
          <label class="bbs-mini-field">
            <span>Nhiệt độ (Temperature)</span>
            <input v-model.number="editingChannel.temperature" class="bbs-input" type="number" step="0.1" min="0" max="2" />
          </label>
          <label class="bbs-mini-field">
            <span>Token tối đa</span>
            <input v-model.number="editingChannel.maxTokens" class="bbs-input" type="number" step="256" min="256" />
          </label>
        </div>
        <label class="bbs-switch-row">
          <span class="bbs-modal-label">Truyền dữ liệu luồng (stream)</span>
          <input v-model="editingChannel.stream" type="checkbox" class="bbs-checkbox" />
        </label>
        <label class="bbs-switch-row">
          <span class="bbs-modal-label">Gửi tiền điền (prefill)</span>
          <input v-model="editingChannel.prefill" type="checkbox" class="bbs-checkbox" />
        </label>
        <span class="bbs-field-hint">Mặc định bật. Nếu thông báo lỗi API phụ xuất hiện chữ prefill, chỉ cần tắt đi.</span>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Loại trừ tham số</span>
          <input
            v-model="excludeParamsText"
            class="bbs-input"
            type="text"
            placeholder="Phân cách bằng dấu phẩy, ví dụ temperature, max_tokens"
          />
          <span class="bbs-field-hint">Các tham số này sẽ bị xóa khỏi body trước khi gửi yêu cầu, nhằm tránh lỗi với các endpoint tương thích không nhận tham số đó. Phân cách bằng dấu phẩy, để trống là không loại trừ.</span>
        </label>
        <p v-if="testing[editingChannel.id]" class="bbs-channel-test">{{ testing[editingChannel.id] }}</p>

        <footer class="bbs-modal-foot">
          <!-- Xóa靠左、与右侧主操作拉开,破坏性动作不与「Hoàn tất」相邻,降低误触。
               Xóa:始终显示文字;Kiểm tra:PC 显「Kiểm tra kênh」,移动端只显「Kiểm tra」(短版,省版面) -->
          <button class="bbs-btn bbs-btn-danger" type="button" @click="askRemoveChannel">
            <Icon name="trash" /> Xóa
          </button>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn" type="button" title="Kiểm tra kênh" @click="doTest(editingChannel)">
            <Icon name="plug" /> <span class="bbs-btn-label-full">Kiểm tra kênh</span><span class="bbs-btn-label-short">Kiểm tra</span>
          </button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="confirmChannel">Hoàn tất</button>
        </footer>

        <!-- Xóa kênh二次确认:叠在Kênh弹窗之上。置于 v-if="editingChannel" 块内,
             Kênh为 null 时整体不渲染——既合语义,也让 editingChannel.name Loại收窄。
             ConfirmDialog 自身 teleport + top-layer,放这儿不影响其渲染层级。 -->
        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="Xóa kênh"
          confirm-text="Xóa"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemoveChannel"
        >
          Bạn có chắc chắn muốn xóa kênh "{{ editingChannel.name || 'Kênh chưa đặt tên' }}" không? Thao tác này không thể hoàn tác, các nhiệm vụ đã chỉ định cho kênh này sẽ bị xóa bỏ.
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== 提示词编辑弹窗 ===== -->
    <ModalMask :open="!!editingPrompt" @close="closePrompt">
      <div v-if="editingPrompt" class="bbs-modal bbs-modal-wide" role="dialog" aria-modal="true" :aria-label="`Chỉnh sửa ${editingPrompt.label}`">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Chỉnh sửa {{ editingPrompt.label }}</span>
          <button class="bbs-icon-mini" type="button" title="Đóng" @click="closePrompt"><Icon name="close" /></button>
        </header>

        <p class="bbs-modal-label">{{ editingPrompt.hint }}</p>

        <!-- 可用宏:点一下插入到光标处 -->
        <div class="bbs-macro-bar">
          <span class="bbs-macro-tip">Nhấn để chèn macro:</span>
          <button
            v-for="mac in editingPrompt.macros"
            :key="mac.token"
            class="bbs-macro"
            type="button"
            :title="mac.desc"
            @click="insertMacro(mac.token)"
          >
            {{ mac.token }}
          </button>
        </div>

        <textarea
          ref="promptArea"
          v-model="promptDraft"
          class="bbs-input bbs-prompt-area"
          spellcheck="false"
          rows="16"
        ></textarea>

        <footer class="bbs-modal-foot">
          <button class="bbs-btn bbs-btn-danger" type="button" @click="resetPrompt">
            <Icon name="refresh" /> Khôi phục mặc định
          </button>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn" type="button" @click="closePrompt">Hủy bỏ</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="savePrompt">Hoàn tất</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Loại trừ nhân vật弹窗:搜索 + 勾选列表 ===== -->
    <ModalMask :open="excludeOpen" @close="closeExclude">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa danh sách loại trừ">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Loại trừ nhân vật</span>
          <button class="bbs-icon-mini" type="button" title="Đóng" @click="closeExclude"><Icon name="close" /></button>
        </header>

        <input
          v-model="excludeSearch"
          class="bbs-input"
          type="search"
          placeholder="Tìm tên nhân vật..."
          spellcheck="false"
        />

        <div class="bbs-exclude-list">
          <label v-for="name in filteredCharNames" :key="name" class="bbs-exclude-row">
            <input
              type="checkbox"
              class="bbs-checkbox"
              :checked="isExcluded(name)"
              @change="toggleExcluded(name)"
            />
            <span class="bbs-exclude-row-name">{{ name }}</span>
          </label>
          <p v-if="!charNames.length" class="bbs-field-hint">Không đọc được danh sách nhân vật. Vui lòng tải thẻ nhân vật trong ST trước.</p>
          <p v-else-if="!filteredCharNames.length" class="bbs-field-hint">Không có nhân vật nào khớp với 「{{ excludeSearch }}」.</p>
        </div>

        <footer class="bbs-modal-foot">
          <span class="bbs-exclude-count">Tổng {{ charNames.length }} nhân vật · Đã loại trừ {{ apiSettings.excludedChars.length }}</span>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="closeExclude">Hoàn tất</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 排除世界书弹窗:搜索 + 勾选列表(复刻Loại trừ nhân vật) ===== -->
    <ModalMask :open="excludeWorldOpen" @close="closeExcludeWorld">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa danh sách loại trừ thế giới thư">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Loại trừ nguyên bộ thế giới thư</span>
          <button class="bbs-icon-mini" type="button" title="Đóng" @click="closeExcludeWorld"><Icon name="close" /></button>
        </header>

        <input
          v-model="excludeWorldSearch"
          class="bbs-input"
          type="search"
          placeholder="Tìm tên thế giới thư..."
          spellcheck="false"
        />

        <div class="bbs-exclude-list">
          <label v-for="name in filteredWorldNames" :key="name" class="bbs-exclude-row">
            <input
              type="checkbox"
              class="bbs-checkbox"
              :checked="isWorldExcluded(name)"
              @change="toggleWorldExcluded(name)"
            />
            <span class="bbs-exclude-row-name">{{ name }}</span>
          </label>
          <p v-if="!worldNames.length" class="bbs-field-hint">Không đọc được thế giới thư. Vui lòng tải / gắn thế giới thư trong ST trước.</p>
          <p v-else-if="!filteredWorldNames.length" class="bbs-field-hint">Không có thế giới thư nào khớp với 「{{ excludeWorldSearch }}」.</p>
        </div>

        <footer class="bbs-modal-foot">
          <span class="bbs-exclude-count">Tổng {{ worldNames.length }} bộ · Đã loại trừ {{ apiSettings.excludedWorldNames.length }}</span>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="closeExcludeWorld">Hoàn tất</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== 更新确认弹窗 ===== -->
    <ConfirmDialog
      v-model:open="updateConfirmOpen"
      title="Phát hiện phiên bản mới"
      confirm-text="Cập nhật và làm mới"
      busy-text="Đang cập nhật..."
      :busy="updateState.updating"
      @confirm="confirmUpdate"
    >
      Phiên bản hiện tại v{{ updateState.current || '—' }}, phiên bản mới nhất v{{ updateState.latest }}.<br />Cập nhật ngay bây giờ? Sau khi hoàn tất sẽ tự động làm mới trang để có hiệu lực.
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbs-page {
  display: flex;
  flex-direction: column;
}
.bbs-sections {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* —— 标题行:左标题 + 右版本号(及更新按钮) —— */
.bbs-page-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.bbs-ver-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* 版本标签:实心强调底 + 白字(粉彩=粉底白字,各主题随 --bbs-accent 自适应) */
.bbs-ver {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  cursor: pointer;
  font-family: var(--bbs-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-ver:hover {
  opacity: 0.88;
}
.bbs-ver:disabled {
  cursor: default;
}
.bbs-ver:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 2px;
}

.bbs-field {
  margin-bottom: 18px;
}
.bbs-field:last-child {
  margin-bottom: 0;
}
.bbs-field-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.bbs-field-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
}
/* 字段右上角的数Giá trị(如透明度百分比) */
.bbs-field-value {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--bbs-accent);
}

/* 滑块:用主题色,跨浏览器统一外观 */
.bbs-range {
  width: 100%;
  height: 4px;
  margin: 6px 0 12px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}
.bbs-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  border: 2px solid var(--bbs-surface);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
}
.bbs-range::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  border: 2px solid var(--bbs-surface);
}
.bbs-range:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 3px;
}
.bbs-field-hint {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  line-height: 1.6;
}

.bbs-segmented {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  background: var(--bbs-surface-2);
  border-radius: var(--bbs-radius);
}
/* 主题选项可能较多/标签较长:允许换行,窄屏下不溢出 */
.bbs-segmented-wrap {
  display: flex;
  flex-wrap: wrap;
}
.bbs-seg {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 18px;
  background: transparent;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-sans);
  font-size: 13px;
  cursor: pointer;
  transition:
    background var(--bbs-dur) var(--bbs-ease),
    color var(--bbs-dur) var(--bbs-ease);
}
.bbs-seg:hover {
  color: var(--bbs-ink);
}
.bbs-seg.is-on {
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.08);
}

/* 任务指派 */
.bbs-assign {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbs-assign-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.bbs-select {
  max-width: 60%;
  font-size: 12px;
  /* 去掉原生右侧大留白的下拉箭头,换一枚紧贴文字的自绘小三角(右内边距随之收紧) */
  appearance: none;
  -webkit-appearance: none;
  padding-right: 26px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9.5 12 15.5 18 9.5'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 14px;
}
/* —— Mô hình可搜索 combobox —— */
.bbs-combo {
  position: relative;
  flex: 1;
  min-width: 0;
}
.bbs-combo .bbs-input {
  width: 100%;
  padding-right: 26px; /* 给右侧自绘三角让位,文字不压到箭头 */
}
/* 自绘下拉三角:与原生 <select> 同款 SVG,贴右侧居中;展开时翻转。装饰元素不拦点击 */
.bbs-combo-caret {
  position: absolute;
  top: 50%;
  right: 8px;
  width: 14px;
  height: 14px;
  transform: translateY(-50%);
  pointer-events: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9.5 12 15.5 18 9.5'/></svg>");
  background-repeat: no-repeat;
  background-position: center;
  background-size: 14px;
  transition: transform 0.15s ease;
}
.bbs-combo-caret.is-open {
  transform: translateY(-50%) rotate(180deg);
}
/* 过滤菜单:绝对定位贴在输入框下方,限高滚动,长列表不撑爆弹窗 */
.bbs-combo-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 6;
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 220px;
  overflow-y: auto;
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  box-shadow: var(--bbs-shadow);
}
.bbs-combo-item {
  padding: 7px 9px;
  border-radius: var(--bbs-radius-sm);
  font-size: 12.5px;
  color: var(--bbs-ink);
  cursor: pointer;
  word-break: break-all;
}
.bbs-combo-item:hover {
  background: var(--bbs-surface-2);
}
.bbs-combo-item.is-active {
  color: var(--bbs-accent);
  font-weight: 600;
}
.bbs-combo-empty {
  padding: 7px 9px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* 小一号按钮:用于「ThêmKênh」等次级操作 */
.bbs-btn-sm {
  padding: 6px 11px;
  font-size: 12px;
}

/* 悬浮球图标配置:预览方块 + 操作按钮 */
.bbs-orb-config {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.bbs-orb-preview {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  font-size: 22px;
  overflow: hidden;
}
.bbs-orb-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* 预览随所选形状变化,让用户直观看到效果 */
.bbs-orb-preview.shape-bookmark {
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%);
  border-color: transparent;
}
.bbs-orb-preview.shape-circle {
  border-radius: 999px;
}
.bbs-orb-preview.shape-square {
  border-radius: 12px;
}
.bbs-orb-config-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* Kiểm tra按钮文字:Mặc định(PC)显完整版,短版藏起;窄屏在媒体查询里互换 */
.bbs-btn-label-short {
  display: none;
}

/* Kênh:顶部操作条(标签 + Thêm按钮) */
.bbs-channel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

/* Kênh:紧凑只读列表,每Kênh一行,点行进弹窗编辑 */
.bbs-channel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbs-channel-item {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
/* 行主体:整块可点,左Tên右Mô hình */
.bbs-channel-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbs-dur) var(--bbs-ease), background var(--bbs-dur) var(--bbs-ease);
}
.bbs-channel-open:hover {
  border-color: var(--bbs-accent);
  background: var(--bbs-surface);
}
/* Tên kênh:完整显示,允许换行,占据剩余空间 */
.bbs-channel-item-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}
/* Mô hình名:次要信息,过长则截断,不挤占Tên */
.bbs-channel-item-model {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 弹窗底部:spacer 把XóaKhóa推到最左,与右侧操作分隔 */
.bbs-modal-foot-spacer {
  flex: 1 1 auto;
}
/* 危险操作按钮:描边低调,hover 才显红,避免误触 */
.bbs-btn-danger {
  color: var(--bbs-danger);
  border-color: var(--bbs-line-strong);
}
.bbs-btn-danger:hover {
  color: var(--bbs-danger);
  border-color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}

.bbs-model-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.bbs-model-row .bbs-input {
  flex: 1;
}
.bbs-icon-mini:disabled {
  opacity: 0.5;
  cursor: default;
}
.bbs-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbs-icon-mini:hover {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
}
.bbs-channel-row {
  display: flex;
  gap: 10px;
}
.bbs-mini-field {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}
.bbs-channel-test {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--bbs-ink-soft);
  word-break: break-all;
}

/* Cài đặt tóm tắt控件 */
.bbs-switch-row,
.bbs-num-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}
/* 「Bật ký ức vectơ」是折叠区里独一行开关,不再额外加上 padding,贴合标题节奏 */
.bbs-vec-enable {
  padding-top: 0;
}
/* 紧跟开关行的分割线收掉上边距:开关行自带 8px 下 padding 已够,避免整块显得空旷 */
.bbs-vec-enable-rule {
  margin-top: 0;
}
.bbs-checkbox {
  /* flex 行里长文本会把固定宽高的复选框挤扁 → 禁止收缩,保持标准方形 */
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  accent-color: var(--bbs-accent);
  cursor: pointer;
}
.bbs-num {
  max-width: 110px;
  text-align: right;
}
/* 向量端点的超时/重试:两个短输入并排,label 在上、窄框在下,与上方Mô hình行留出呼吸间距 */
.bbs-vec-io {
  display: flex;
  gap: 16px;
  margin-top: 12px;
}
.bbs-vec-io-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbs-num-sm {
  width: 72px;
  text-align: right;
}
/* 短选项下拉(如Khung số chữ):贴合文字的窄宽,和右侧数字框对齐,不再撑满半行 */
.bbs-select-narrow {
  width: auto;
  min-width: 65px;
  max-width: 150px;
}

/* —— 总开关主控卡 —— */
/* 左缘一道金色书脊,呼应「书」的品牌;停用时整卡褪色、书脊转灰,状态一眼可辨 */
.bbs-master {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
  padding: 16px 18px 16px 16px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  box-shadow: var(--bbs-shadow);
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-master-spine {
  flex: 0 0 auto;
  align-self: stretch;
  width: 4px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  transition: background var(--bbs-dur) var(--bbs-ease);
}
.bbs-master.is-off .bbs-master-spine {
  background: var(--bbs-line-strong);
}
.bbs-master.is-off .bbs-master-text {
  opacity: 0.7;
}
.bbs-master-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.bbs-master-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--bbs-ink);
}

/* —— 通用滑动开关(总开关用,后续别处也可复用) —— */
.bbs-toggle {
  flex: 0 0 auto;
  position: relative;
  width: 46px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-line-strong);
  cursor: pointer;
  transition: background var(--bbs-dur) var(--bbs-ease);
}
.bbs-toggle.is-on {
  background: var(--bbs-accent);
}
.bbs-toggle:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 2px;
}
.bbs-toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bbs-surface);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-toggle.is-on .bbs-toggle-knob {
  transform: translateX(20px);
}

/* —— Ký ức vectơ:每个Mô hìnhNhân vật一组卡片(Kênh + Mô hình名两列) —— */
/* 向量端点卡片(Embedding/Rerank/Query 各一块,扁平填地址/密钥/Mô hình) */
.bbs-vec-ep {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-vec-ep.is-disabled {
  opacity: 0.5;
}
/* Tham số triệu hồi/Bảo trì chỉ mục整组在ĐóngKý ức vectơ时一并置灰 */
.bbs-vec-recall.is-disabled {
  opacity: 0.5;
}
.bbs-vec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
/* 端点卡片折叠头:整条标题栏可点;收起时去掉下间距,卡片只剩一行标题。 */
.bbs-vec-toggle {
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--bbs-ink);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.bbs-vec-toggle:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 4px;
  border-radius: var(--bbs-radius-sm);
}
/* 折叠头不自带下间距,改由 body 的 padding-top 统一供给,
   这样三块标题到首行内容的距离一致(不受CóKhông có提示行影响),收起时随 grid 一并归零。 */
.bbs-vec-toggle.bbs-vec-head {
  margin-bottom: 0;
}
.bbs-vec-ep-body {
  padding-top: 12px;
}
.bbs-vec-chevron {
  font-size: 18px;
  color: var(--bbs-ink-muted);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-vec-ep.is-collapsed .bbs-vec-chevron {
  transform: rotate(-90deg);
}
/* 展开动画:照搬 Collapsible 的 grid 0fr<->1fr,内容自适应高度,Không có需测量。 */
.bbs-vec-ep-outer {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--bbs-dur) var(--bbs-ease);
}
.bbs-vec-ep.is-collapsed .bbs-vec-ep-outer {
  grid-template-rows: 0fr;
}
/* 展开态放开 overflow,否则会裁掉里面Mô hình combobox 绝对定位的下拉菜单(拉取Mô hình后「点不开」);
   折叠动画期间仍需 hidden 来平滑揭示——用离散过渡延迟到动画Kết thúc(0.28s)才切 visible,收起时立即变回 hidden。
   allow-discrete 不支持的旧浏览器降级为立即切换:展开瞬间内容略溢出(小瑕疵),但下拉可用,不再点不开。 */
.bbs-vec-ep-inner {
  min-height: 0;
  overflow: visible;
  transition: overflow 0s var(--bbs-dur);
  transition-behavior: allow-discrete;
}
.bbs-vec-ep.is-collapsed .bbs-vec-ep-inner {
  overflow: hidden;
  transition-delay: 0s;
}
/* 向量后端Loại标签:与摘要列表的「总结」标签同款(实心填充、白字),后端=强调色,本地降级=警告色 */
.bbs-vec-backend {
  box-sizing: border-box;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  font-size: 11px;
  font-weight: 600;
  border-radius: var(--bbs-radius-sm);
  white-space: nowrap;
}
.bbs-vec-backend.is-backend {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
  border: 1px solid var(--bbs-accent);
}
.bbs-vec-backend.is-local {
  color: var(--bbs-accent-ink);
  background: var(--bbs-warning);
  border: 1px solid var(--bbs-warning);
}

/* —— Chi tiết triệu hồi lần trước(调试面板):状态横幅 + 步骤分区 + 分数条卡片 —— */
.bbs-dbg {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 状态横幅:左色点 + 文案 + Thời gian */
.bbs-dbg-banner {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  border-left: 3px solid var(--bbs-line-strong);
}
.bbs-dbg-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bbs-ink-muted);
}
.bbs-dbg-banner.is-ok {
  border-left-color: var(--bbs-accent);
}
.bbs-dbg-banner.is-ok .bbs-dbg-dot {
  background: var(--bbs-accent);
}
.bbs-dbg-banner.is-warn {
  border-left-color: var(--bbs-warning);
}
.bbs-dbg-banner.is-warn .bbs-dbg-dot {
  background: var(--bbs-warning);
}
.bbs-dbg-banner.is-fail {
  border-left-color: var(--bbs-danger);
}
.bbs-dbg-banner.is-fail .bbs-dbg-dot {
  background: var(--bbs-danger);
}
.bbs-dbg-banner.is-pending .bbs-dbg-dot {
  background: var(--bbs-ink-soft);
}
.bbs-dbg-status-text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-dbg-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
}

.bbs-dbg-empty {
  margin: 0;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* Bảo trì chỉ mục:重建/清空按钮并排,窄屏自动换行 */
.bbs-vec-index-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}

/* 重写:INTENT 高亮 + Q 列表 */
.bbs-dbg-intent {
  display: flex;
  gap: 7px;
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-accent-soft);
  font-size: 12px;
  line-height: 1.6;
}
.bbs-dbg-intent-text {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-dbg-tag {
  flex: 0 0 auto;
  align-self: flex-start;
  padding: 1px 6px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  font-family: var(--bbs-font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.3px;
}
.bbs-dbg-qlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbs-dbg-qitem {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--bbs-ink);
}
.bbs-dbg-qno {
  flex: 0 0 auto;
  min-width: 22px;
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--bbs-accent);
}
.bbs-dbg-qtext {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}

/* 命中卡片列表:固定高度内滑动,长列表不把折叠区撑得很长。 */
.bbs-dbg-cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.bbs-dbg-card {
  padding: 8px 10px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
}
.bbs-dbg-card.is-dropped {
  opacity: 0.55;
}
.bbs-dbg-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
/* 来源 Q 徽标 */
.bbs-dbg-src {
  flex: 0 0 auto;
  min-width: 38px; /* 与楼层号标签等宽,单数 Q 也不至于太窄 */
  text-align: center;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 700;
}
/* 来源标记:本聊天楼层号(中性)/ 旧档(描边提示色) */
.bbs-dbg-from {
  flex: 0 0 auto;
  min-width: 38px; /* 楼层号个位数(#5)也不至于太窄,与 Q 标签视觉等宽 */
  text-align: center;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-pill);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
}
.bbs-dbg-from.is-bundle {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
  border-color: transparent;
}
.bbs-dbg-when {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--bbs-ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bbs-dbg-num {
  flex: 0 0 auto;
  margin-left: auto;
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--bbs-ink);
  font-variant-numeric: tabular-nums;
}
/* 分数条:细轨 + 填充;Mặc định强调色,rerank 各档分色 */
.bbs-dbg-bar {
  height: 4px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-line);
  overflow: hidden;
}
.bbs-dbg-bar > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--bbs-accent);
  transition: width var(--bbs-dur) var(--bbs-ease);
}
.bbs-dbg-bar.tier-brief > i {
  background: var(--bbs-ink-soft);
}
.bbs-dbg-bar.tier-drop > i {
  background: var(--bbs-ink-muted);
}
.bbs-dbg-prev {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--bbs-ink-muted);
  word-break: break-word;
}
/* 分档徽标:全文(强调实底)/摘要(中性)/丢弃(描边褪色) */
.bbs-dbg-tier {
  flex: 0 0 auto;
  min-width: 32px;
  text-align: center;
  padding: 1px 8px;
  border-radius: var(--bbs-radius-pill);
  font-size: 11px;
  font-weight: 700;
}
.bbs-dbg-tier.is-full {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
}
.bbs-dbg-tier.is-brief {
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
}
.bbs-dbg-tier.is-drop {
  color: var(--bbs-ink-muted);
  background: transparent;
  border: 1px solid var(--bbs-line);
}
/* 注入文本框:等宽、限高滚动 */
.bbs-dbg-pre {
  margin: 0;
  padding: 10px 12px;
  max-height: 320px;
  overflow: auto;
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--bbs-ink);
}

/* —— Lời nhắc tùy chỉnh列表 —— */
.bbs-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 整行可点进弹窗编辑;布局沿用Kênh列表的观感(描边、hover 显强调色) */
.bbs-prompt-open {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbs-dur) var(--bbs-ease), background var(--bbs-dur) var(--bbs-ease);
}
.bbs-prompt-open:hover {
  border-color: var(--bbs-accent);
  background: var(--bbs-surface);
}
.bbs-prompt-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}
/* 状态药丸:Mặc định muted,Đã tùy chỉnh转金强调 */
.bbs-prompt-state {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
  color: var(--bbs-ink-muted);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line);
}
.bbs-prompt-state.is-custom {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  border-color: transparent;
}
.bbs-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbs-ink-muted);
}
.bbs-prompt-open:hover .bbs-prompt-edit {
  color: var(--bbs-accent);
}

/* —— 提示词弹窗:更宽 + 大文本框 —— */
.bbs-modal-wide {
  max-width: 680px;
}
/* 宏标签条:可横向裹行,每个宏点击插入 */
.bbs-macro-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.bbs-macro-tip {
  font-size: 12px;
  color: var(--bbs-ink-muted);
  margin-right: 2px;
}
.bbs-macro {
  padding: 3px 9px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--bbs-dur) var(--bbs-ease), border-color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-macro:hover {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-prompt-area {
  resize: vertical;
  min-height: 240px;
  line-height: 1.6;
  font-family: var(--bbs-font-mono);
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}

/* —— Nhãn làm sạch tùy chỉnh:输入框 + Thêm按钮一行 —— */
.bbs-striptag-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.bbs-striptag-bar .bbs-input {
  flex: 1;
  min-width: 0;
}
.bbs-striptag-bar .bbs-btn {
  flex: none;
}

/* —— Loại trừ nhân vật:已排除Tên以药丸形式平铺,点 × 移出 —— */
.bbs-exclude-chips {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.bbs-exclude-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 11px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font-size: 12px;
  font-weight: 600;
}
.bbs-exclude-chip-name {
  word-break: break-word;
}
.bbs-exclude-chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.7;
}
.bbs-exclude-chip-x:hover {
  opacity: 1;
  background: oklch(0 0 0 / 0.08);
}

/* 弹窗内Nhân vật勾选列表:固定高度内滚动,长名单不撑爆弹窗 */
.bbs-exclude-list {
  max-height: 46vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0;
  padding-right: 2px;
}
.bbs-exclude-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border-radius: var(--bbs-radius-sm);
  cursor: pointer;
}
.bbs-exclude-row:hover {
  background: var(--bbs-surface-2);
}
.bbs-exclude-row-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-exclude-count {
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* ============ 移动端:折叠区内部正文整体收一号,与窄屏标题节奏统一 ============ */
@media (max-width: 640px) {
  .bbs-field-label,
  .bbs-channel-item-name {
    font-size: 13px;
  }
  .bbs-prompt-name {
    font-size: 12px;
  }
  .bbs-field-hint,
  .bbs-channel-item-model {
    font-size: 11px;
  }
  .bbs-seg {
    font-size: 12px;
  }
  /* Kênh弹窗底部:Kiểm tra按钮窄屏只显短版「Kiểm tra」,PC 显完整「Kiểm tra kênh」 */
  .bbs-btn-label-full {
    display: none;
  }
  .bbs-btn-label-short {
    display: inline;
  }
}
</style>
