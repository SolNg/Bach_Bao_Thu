import type { Component } from 'vue';
import Items from './items/index.vue';
import Npcs from './npcs/index.vue';
import Scenes from './scenes/index.vue';
import Settings from './settings/index.vue';
import Summary from './summary/index.vue';
import Vars from './vars/index.vue';

export interface PageDef {
  /** 唯一 id,存进 ui.activePage / localStorage;同时作为 Icon 的 name */
  id: string;
  /** 导航栏全称 */
  label: string;
  component: Component;
}

/**
 * 分页注册表 —— Thêm mới一页:建一个 pages/<id>/index.vue,再往这里加一行,
 * 并在 Icon.vue 的 PATHS 里加一mục同 id 的图标。顺序即导航顺序,Cài đặt放最末。
 *
 * 计划/Huyền niệm已并入Tóm tắt页(上方),不再单独成页。
 */
export const PAGES: PageDef[] = [
  { id: 'summary', label: 'Tóm tắt', component: Summary },
  { id: 'items', label: 'Vật phẩm', component: Items },
  { id: 'scenes', label: 'Bối cảnh', component: Scenes },
  { id: 'npcs', label: 'Nhân vật', component: Npcs },
  { id: 'vars', label: 'Biến số', component: Vars },
  { id: 'settings', label: 'Cài đặt', component: Settings },
];

export function getPage(id: string): PageDef {
  return PAGES.find(p => p.id === id) ?? PAGES[0];
}
