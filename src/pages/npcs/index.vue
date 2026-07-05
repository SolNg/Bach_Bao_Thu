<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalMask from '@/components/ModalMask.vue';
import { classifyNpcPresence, editNpc, removeNpc, setNpcFollow, setNpcImportant, upsertNpc } from '@/memory/apply';
import { derivedMeta, memory } from '@/memory/store';
import type { MemNpc } from '@/memory/types';
import { computed, nextTick, ref } from 'vue';

// NPC 是从叶子摘要重放出的派生数据,手动操作写入「最新一条Có效叶子」;Không cóCó效叶子时Không có处挂载。
const hasLeaf = computed(() => derivedMeta.hasLeaf);

// 触屏判定:跳过弹窗自动聚焦(移动端自动聚焦会弹输入法挡界面),与场景/摘要页一致。
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

// 在场分档:与注入端(inject.ts)共用同一权威 classifyNpcPresence —— 读 location + locationPath,
// 杜绝两套逻辑漂移,确保「界面显示的 = AI 收到的」。四档:
//   主要Nhân vật(置顶,不论在场)/ 在场(全量)/ 同区域(名+身份+性格)/ Không có mặt(名+身份)。
const sortByCreated = (a: MemNpc, b: MemNpc) => a.createdAt - b.createdAt;

// 单趟分桶:每个非主要Nhân vật只判一次在场,避免三个 computed 各判一遍。
const buckets = computed(() => {
  const present: MemNpc[] = [];
  const nearby: MemNpc[] = [];
  const absent: MemNpc[] = [];
  const here = memory.state.location || '';
  const locPath = memory.state.locationPath;
  for (const n of memory.npcs) {
    if (n.important) continue; // 主要Nhân vật单列,不进在场判定
    const p = classifyNpcPresence(n, memory.scenes, here, locPath);
    (p === 'present' ? present : p === 'nearby' ? nearby : absent).push(n);
  }
  present.sort(sortByCreated);
  nearby.sort(sortByCreated);
  absent.sort(sortByCreated);
  return { present, nearby, absent };
});
const mains = computed(() => memory.npcs.filter(n => n.important).sort(sortByCreated));
const present = computed(() => buckets.value.present);
const nearby = computed(() => buckets.value.nearby);
const absent = computed(() => buckets.value.absent);

/* —— 随行一Khóa开关:随行→Hủy bỏ(留在Địa điểm hiện tại);非随行→标记随行 —— */
function toggleFollow(npc: MemNpc) {
  if (npc.follow === true) {
    // Hủy bỏ随行:留在当前所在地(Không có则留空,成为Không có位置的游离 NPC)
    setNpcFollow(npc.name, false, memory.state.location || '');
  } else {
    setNpcFollow(npc.name, true);
  }
}

/* —— 主要Nhân vật一Khóa升/降 —— */
function toggleImportant(npc: MemNpc) {
  setNpcImportant(npc.name, !npc.important);
}

function askRemove(npc: MemNpc) {
  removing.value = npc;
}

/* —— 新增弹窗 —— */
const composerOpen = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);
interface NpcDraft {
  name: string;
  title: string;
  personality: string;
  desc: string;
  outfit: string;
  condition: string;
  important: boolean;
  follow: boolean;
  location: string;
}
function emptyDraft(): NpcDraft {
  return { name: '', title: '', personality: '', desc: '', outfit: '', condition: '', important: false, follow: false, location: memory.state.location || '' };
}
const draft = ref<NpcDraft>(emptyDraft());

function openComposer() {
  if (!hasLeaf.value) return;
  draft.value = emptyDraft();
  composerOpen.value = true;
  if (!isTouch) void nextTick(() => nameInput.value?.focus());
}
function closeComposer() {
  composerOpen.value = false;
}
function addNpc() {
  const d = draft.value;
  if (!d.name.trim()) return;
  const ok = upsertNpc({
    name: d.name,
    title: d.title,
    personality: d.personality,
    desc: d.desc,
    outfit: d.outfit,
    condition: d.condition,
    important: d.important,
    follow: d.follow,
    location: d.follow ? '' : d.location,
  });
  if (!ok) return;
  composerOpen.value = false;
}

/* —— Chỉnh sửa弹窗 —— */
interface NpcEditing extends NpcDraft {
  oldName: string;
}
const editing = ref<NpcEditing | null>(null);

function openEdit(npc: MemNpc) {
  editing.value = {
    oldName: npc.name,
    name: npc.name,
    title: npc.title ?? '',
    personality: npc.personality ?? '',
    desc: npc.desc ?? '',
    outfit: npc.outfit ?? '',
    condition: npc.condition ?? '',
    important: npc.important === true,
    follow: npc.follow === true,
    location: npc.location ?? '',
  };
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  const e = editing.value;
  if (!e || !e.name.trim()) return;
  editNpc(e.oldName, {
    name: e.name,
    title: e.title,
    personality: e.personality,
    desc: e.desc,
    outfit: e.outfit,
    condition: e.condition,
    important: e.important,
    follow: e.follow,
    location: e.follow ? '' : e.location,
  });
  editing.value = null;
}

/* —— Xóa确认 —— */
const removing = ref<MemNpc | null>(null);
function confirmRemove() {
  if (removing.value) removeNpc(removing.value.name);
  removing.value = null;
}
</script>

<template>
  <section class="bbs-page">
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">Nhân vật</h2>
      <button
        class="bbs-add-mini"
        type="button"
        :disabled="!hasLeaf"
        :title="hasLeaf ? 'Thêm nhân vật thủ công' : 'Cần có tóm tắt trước để thêm thủ công'"
        @click="openComposer"
      >
        <Icon name="plus" />
      </button>
    </div>

    <hr class="bbs-rule" />

    <div v-if="memory.npcs.length" class="bbs-npc-groups">
      <!-- 主要Nhân vật:核心主演,永远全量发送。这里突出「即时状态面板」(着装/状态/所在),弱化身份档案 -->
      <div v-if="mains.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-main"><Icon name="star" />Nhân vật chính</span>
          <span class="bbs-npc-grouphint">Luôn gửi theo cốt truyện, tập trung duy trì trạng thái hiện tại</span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in mains" :key="n.id" class="bbs-npc is-present is-main">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name">{{ n.name }}</span>
                <span v-if="n.title" class="bbs-npc-flag">{{ n.title }}</span>
                <span class="bbs-npc-acts">
                  <button class="bbs-item-act bbs-npc-star active" type="button" title="Nhân vật chính · Nhấn hủy" @click="toggleImportant(n)"><Icon name="star" /></button>
                  <button class="bbs-item-act" type="button" title="Chỉnh sửa" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="Xóa" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.outfit || n.condition || n.follow || n.location" class="bbs-npc-fields">
                <div v-if="n.outfit" class="bbs-npc-field f-outfit"><dt>Trang phục</dt><dd>{{ n.outfit }}</dd></div>
                <div v-if="n.condition" class="bbs-npc-field f-cond"><dt>Trạng thái</dt><dd>{{ n.condition }}</dd></div>
                <div v-if="n.follow || n.location" class="bbs-npc-field f-loc">
                  <dt>Nơi ở</dt><dd>{{ n.follow ? 'Đồng hành cùng nhân vật chính' : n.location }}</dd>
                </div>
              </dl>
              <p v-else class="bbs-npc-mainhint">Chưa có ghi chép trạng thái —— Chỉnh sửa để bổ sung trang phục / trạng thái / nơi ở hiện tại.</p>
            </div>
          </article>
        </div>
      </div>

      <!-- 在场:随行 / 所在当前场景。全量信息发给 AI,这里也全量展示 -->
      <div v-if="present.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-present">Có mặt</span>
          <span class="bbs-npc-grouphint">Gửi thông tin đầy đủ theo cốt truyện</span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in present" :key="n.id" class="bbs-npc is-present" :class="{ 'is-follow': n.follow }">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name">{{ n.name }}</span>
                <span v-if="n.follow" class="bbs-npc-flag is-follow"><Icon name="pin" />Đồng hành</span>
                <span v-else-if="n.location" class="bbs-npc-flag"><Icon name="scenes" />{{ n.location }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    title="Đánh dấu nhân vật chính (luôn gửi toàn bộ, theo dõi trạng thái)"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    :class="{ active: n.follow }"
                    type="button"
                    :title="n.follow ? 'Đang đồng hành · Nhấn hủy (ở lại địa điểm hiện tại)' : 'Đánh dấu đồng hành'"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button class="bbs-item-act" type="button" title="Chỉnh sửa" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="Xóa" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.title || n.personality || n.desc || n.outfit || n.condition" class="bbs-npc-fields">
                <div v-if="n.title" class="bbs-npc-field f-title"><dt>Thân phận</dt><dd>{{ n.title }}</dd></div>
                <div v-if="n.outfit" class="bbs-npc-field f-outfit"><dt>Trang phục</dt><dd>{{ n.outfit }}</dd></div>
                <div v-if="n.condition" class="bbs-npc-field f-cond"><dt>Trạng thái</dt><dd>{{ n.condition }}</dd></div>
                <div v-if="n.personality" class="bbs-npc-field f-trait"><dt>Tính cách</dt><dd>{{ n.personality }}</dd></div>
                <div v-if="n.desc" class="bbs-npc-field f-desc"><dt>Ngoại hình</dt><dd>{{ n.desc }}</dd></div>
              </dl>
            </div>
          </article>
        </div>
      </div>

      <!-- 同区域:在附近但未必照面。发名+身份+性格给 AI,这里也只展示这三样 -->
      <div v-if="nearby.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-nearby">Cùng khu vực</span>
          <span class="bbs-npc-grouphint">Ở gần đây, gửi tên, thân phận và tính cách</span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in nearby" :key="n.id" class="bbs-npc is-nearby">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name">{{ n.name }}</span>
                <span v-if="n.location" class="bbs-npc-flag"><Icon name="scenes" />{{ n.location }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    title="Đánh dấu nhân vật chính (luôn gửi toàn bộ, theo dõi trạng thái)"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    type="button"
                    title="Đánh dấu bạn đồng hành (sẽ đi cùng nhân vật chính)"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button class="bbs-item-act" type="button" title="Chỉnh sửa" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="Xóa" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.title || n.personality" class="bbs-npc-fields">
                <div v-if="n.title" class="bbs-npc-field f-title"><dt>Thân phận</dt><dd>{{ n.title }}</dd></div>
                <div v-if="n.personality" class="bbs-npc-field f-trait"><dt>Tính cách</dt><dd>{{ n.personality }}</dd></div>
              </dl>
            </div>
          </article>
        </div>
      </div>

      <!-- Không có mặt:只发名+身份给 AI,这里也压暗、收起细节 -->
      <div v-if="absent.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag">Không có mặt</span>
          <span class="bbs-npc-grouphint">Chỉ gửi tên và thân phận, tiết kiệm token</span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in absent" :key="n.id" class="bbs-npc is-absent">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name">{{ n.name }}</span>
                <span v-if="n.location" class="bbs-npc-flag"><Icon name="scenes" />{{ n.location }}</span>
                <span v-else class="bbs-npc-flag is-nowhere">Không rõ vị trí</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    title="Đánh dấu nhân vật chính (luôn gửi toàn bộ, theo dõi trạng thái)"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    type="button"
                    title="Đánh dấu bạn đồng hành (sẽ đi cùng nhân vật chính)"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button class="bbs-item-act" type="button" title="Chỉnh sửa" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="Xóa" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.title" class="bbs-npc-fields">
                <div class="bbs-npc-field f-title"><dt>Thân phận</dt><dd>{{ n.title }}</dd></div>
              </dl>
            </div>
          </article>
        </div>
      </div>
    </div>

    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="npcs" /></span>
      <p>Chưa có nhân vật nào xuất hiện. Khi tóm tắt sẽ ghi lại các nhân vật có tương tác với nhân vật chính, cũng có thể nhấn 「+」 góc trên bên phải để thêm thủ công.</p>
    </div>

    <!-- Thêm弹窗:position:fixed 内联(不用 Teleport,见 base.css 说明) -->
    <ModalMask :open="composerOpen" @close="closeComposer">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Thêm nhân vật">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Thêm nhân vật</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="closeComposer"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tên</span>
          <input ref="nameInput" v-model="draft.name" class="bbs-input" type="text" placeholder="Tên nhân vật" @keydown.enter="addNpc" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Thân phận (nghề nghiệp / quan hệ với nhân vật chính)</span>
          <textarea v-model="draft.title" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Ví dụ: Chưởng quỳ Quán trọ Quy Nhạn, Thanh mai trúc mã"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tính cách</span>
          <textarea v-model="draft.personality" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Ví dụ: Ít nói, Bảo vệ người mình"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Mô tả ngoại hình (đặc điểm cố định: màu tóc / vóc dáng / sẹo, không ghi trang phục)</span>
          <textarea v-model="draft.desc" class="bbs-input bbs-modal-textarea" rows="2" placeholder="Tùy chọn"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Trang phục hiện tại (thay đổi theo cốt truyện)</span>
          <textarea v-model="draft.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Ví dụ: Áo choàng đỏ, Đeo trường kiếm"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Trạng thái hiện tại (Bị thương / Mệt mỏi..., không có thì để trống)</span>
          <textarea v-model="draft.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Tùy chọn"></textarea>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="draft.important" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">Nhân vật chính (diễn viên cốt lõi, luôn gửi toàn bộ, tập trung theo dõi trạng thái)</span>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="draft.follow" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">Bạn đồng hành (đi theo nhân vật chính, luôn có mặt)</span>
        </label>
        <label v-if="!draft.follow" class="bbs-modal-field">
          <span class="bbs-modal-label">Nơi ở hiện tại</span>
          <textarea v-model="draft.location" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Ví dụ: Quán trọ Quy Nhạn, Hoàng cung"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeComposer">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!draft.name.trim()" @click="addNpc">Thêm</button>
        </footer>
      </div>
    </ModalMask>

    <!-- Chỉnh sửa弹窗 -->
    <ModalMask :open="!!editing" @close="cancelEdit">
      <div v-if="editing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa nhân vật">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Chỉnh sửa nhân vật</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="cancelEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tên</span>
          <input v-model="editing.name" class="bbs-input" type="text" placeholder="Tên nhân vật" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Thân phận (nghề nghiệp / quan hệ với nhân vật chính)</span>
          <textarea v-model="editing.title" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Ví dụ: Chưởng quỳ Quán trọ Quy Nhạn, Thanh mai trúc mã"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tính cách</span>
          <textarea v-model="editing.personality" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Ví dụ: Ít nói, Bảo vệ người mình"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Mô tả ngoại hình (đặc điểm cố định: màu tóc / vóc dáng / sẹo, không ghi trang phục)</span>
          <textarea v-model="editing.desc" class="bbs-input bbs-modal-textarea" rows="2" placeholder="Tùy chọn"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Trang phục hiện tại (thay đổi theo cốt truyện)</span>
          <textarea v-model="editing.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Ví dụ: Áo choàng đỏ, Đeo trường kiếm"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Trạng thái hiện tại (Bị thương / Mệt mỏi..., không có thì để trống)</span>
          <textarea v-model="editing.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Tùy chọn"></textarea>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.important" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">Nhân vật chính (diễn viên cốt lõi, luôn gửi toàn bộ, tập trung theo dõi trạng thái)</span>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.follow" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">Bạn đồng hành (đi theo nhân vật chính, luôn có mặt)</span>
        </label>
        <label v-if="!editing.follow" class="bbs-modal-field">
          <span class="bbs-modal-label">Nơi ở hiện tại</span>
          <textarea v-model="editing.location" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Ví dụ: Quán trọ Quy Nhạn, Hoàng cung"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editing.name.trim()" @click="saveEdit">Lưu</button>
        </footer>
      </div>
    </ModalMask>

    <ConfirmDialog
      :open="!!removing"
      title="Xóa nhân vật"
      tone="danger"
      confirm-text="Xóa"
      confirm-icon="trash"
      @update:open="v => { if (!v) removing = null; }"
      @confirm="confirmRemove"
      @cancel="removing = null"
    >
      Xóa "{{ removing?.name }}". Thao tác này ghi vào tóm tắt mới nhất, xóa tầng có thể hoàn tác.
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.bbs-npc-groups {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.bbs-npc-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 分组头:在场/Không có mặt是这页的信息骨架(= AI 实际收到的分档),用细标签 + 一句说明点明取舍 */
.bbs-npc-grouphead {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.bbs-npc-grouptag {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-npc-grouptag.is-present {
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
/* 同区域:描边空心 pill —— 介于「在场(实心强调)」与「Không có mặt(实心灰底)」之间 */
.bbs-npc-grouptag.is-nearby {
  background: transparent;
  border: 1px solid var(--bbs-line-strong);
  padding: 1px 8px; /* 补偿 1px 边框,保持与实心标签等高 */
}
/* 主要Nhân vật分组标签:同强调底色 + 星标,与置顶组的「核心」地位呼应 */
.bbs-npc-grouptag.is-main {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
.bbs-npc-grouphint {
  font-size: 11.5px;
  color: var(--bbs-ink-muted);
}

.bbs-npc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* —— Nhân vật卡:与物品/场景同款的安静卡片。在场/随行只用「左侧一道色条」表态,
      不再用大圆球——保持列表整体的克制,把强调留给那道竖条。 —— */
.bbs-npc {
  position: relative;
  display: flex;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  overflow: hidden; /* 让左色条贴着圆角边缘 */
}
/* 在场:左缘一道青瓷色条 */
.bbs-npc.is-present::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--bbs-accent);
  opacity: 0.5;
}
/* 同区域:左色条更细更淡 —— 在「在场(3px@0.5)」与「Không có mặt(Không có条)」之间的一档 */
.bbs-npc.is-nearby::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--bbs-accent);
  opacity: 0.28;
}
/* 随行:色条加粗加实,作同伴的最高标识 */
.bbs-npc.is-follow::before {
  width: 3px;
  opacity: 1;
}
/* 主要Nhân vật:整条左色条加粗实色,卡片更醒目,呼应「核心主演」地位 */
.bbs-npc.is-main::before {
  width: 4px;
  opacity: 1;
}
.bbs-npc.is-main {
  border-color: var(--bbs-line-strong);
}
/* Không có mặt:整行压暗 + 虚线框,与「只发名+身份」的弱化呼应 */
.bbs-npc.is-absent {
  background: transparent;
  border-style: dashed;
}
.bbs-npc.is-absent .bbs-npc-name {
  color: var(--bbs-ink-soft);
}

.bbs-npc-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* 头行:Tên + 一枚状态标(随行/所在地)+ 操作区。Tên占自然宽,状态标吃剩余宽并截断,
   操作区固定不被挤。身份不在这行——长身份单独成段,不再挤乱头行。 */
.bbs-npc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bbs-npc-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
  flex: 0 0 auto;
  white-space: nowrap;
}
.bbs-npc-acts {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}
.bbs-npc-flag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  font-size: 11px;
  color: var(--bbs-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bbs-npc-flag.is-follow {
  color: var(--bbs-accent);
  flex-shrink: 0;
}
.bbs-npc-flag.is-nowhere {
  font-style: italic;
  opacity: 0.7;
}

/* —— 字段表:身份/性格/外貌统一成「彩色类别标签 + Nội dung」的对齐行。
      标签同宽左对齐成一条竖列,用语义色区分类别,Nội dung统一字号——治「三行同灰、层次乱」。 —— */
.bbs-npc-fields {
  margin: 2px 0 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.bbs-npc-field {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.bbs-npc-field dt {
  flex: 0 0 auto;
  width: 30px;
  text-align: center;
  padding: 1px 0;
  border-radius: var(--bbs-radius-sm);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.04em;
  /* Mặc định中性,具体类别在下方各自染色 */
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-npc-field dd {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
/* 身份:强调金标签——这是最关Khóa的一类身份信息 */
.bbs-npc-field.f-title dt {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-npc-field.f-title dd {
  color: var(--bbs-ink);
}
/* Trang phục:暖色标签——即时层核心,与「会变的当前状态」呼应,Nội dung也加重 */
.bbs-npc-field.f-outfit dt {
  background: var(--bbs-warning-soft);
  color: var(--bbs-warning);
}
.bbs-npc-field.f-outfit dd {
  color: var(--bbs-ink);
}
/* 状态/健康:警示色标签——受伤/异常一眼可辨 */
.bbs-npc-field.f-cond dt {
  background: var(--bbs-danger-soft);
  color: var(--bbs-danger);
}
/* Tính cách:中性偏暖(沿用Mặc định中性,与档案层弱化一致) */
.bbs-npc-field.f-trait dt {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
/* 外貌 / 所在:中性标签(沿用Mặc định),作次要细节 */

/* 主要Nhân vậtKhông có状态时的占位提示:引导补录当前状态,避免空卡 */
.bbs-npc-mainhint {
  margin: 4px 0 0;
  font-size: 12px;
  font-style: italic;
  color: var(--bbs-ink-muted);
}

/* PC(支持 hover)上操作按钮Mặc định隐藏,悬停整卡才浮现;触屏常驻(与物品页一致) */
@media (hover: hover) {
  .bbs-npc-acts {
    opacity: 0;
    transition: opacity var(--bbs-dur) var(--bbs-ease);
  }
  .bbs-npc:hover .bbs-npc-acts,
  .bbs-npc-acts:focus-within {
    opacity: 1;
  }
}

/* 行内操作按钮:复刻 items 页(scoped 不继承,重声明同款) */
.bbs-item-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  cursor: pointer;
  font-size: 14px;
}
.bbs-item-act:hover {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
}
.bbs-item-del:hover {
  color: var(--bbs-danger);
}
/* 随行开关:激活态点亮强调色,把「这是同伴」表达在按钮本身 */
.bbs-npc-pin.active {
  color: var(--bbs-accent);
}
.bbs-npc-pin.active:hover {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
/* 主要Nhân vật星标:激活态点亮(实心感由强调色填充表达) */
.bbs-npc-star.active {
  color: var(--bbs-accent);
}
.bbs-npc-star.active:hover {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
/* 主要Nhân vật卡的操作区常驻(置顶组Không có需 hover 才显,星标本身就是状态指示) */
.bbs-npc.is-main .bbs-npc-acts {
  opacity: 1;
}

.bbs-modal-textarea {
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}
/* 自适应高度:Mặc định贴合一行,Nội dung多才长高(v-autosize 量 scrollHeight 写回);
   min-height 归零、resize 交给指令,封顶后滚动。 */
.bbs-modal-autogrow {
  resize: none;
  min-height: 0;
  max-height: 140px;
  overflow-y: auto;
}
.bbs-modal-check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.bbs-modal-check input {
  flex-shrink: 0;
}
.bbs-empty {
  flex: 1;
}
</style>
