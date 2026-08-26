/**
 * 独立版渲染入口：用「假 DSH 壳」驱动原插件客户端代码（零改动的关键）。
 *
 * 原理：插件客户端的对外契约是 window.__ModuleLoader__.load({id, factory})，
 *       factory(require) 返回 {name, inject, apply}；apply(ctx) 里用
 *       ctx.slots.register('shell.overlay', renderFn) 挂载宠物组件。
 * 独立版没有 DSH，这里手工提供同构的替代品：
 *   - require：映射到真实打包进来的 react / react/jsx-runtime（esbuild 打包）；
 *   - ctx.slots.register：捕获 overlay 的渲染函数（设置页 section 直接跳过）；
 *   - ctx.locale：本地化用恒等函数（菜单文案本就是中文硬编码）；
 *   - ctx.connection：undefined → 通知引擎自动跳过（独立版 v1 无系统通知）；
 *   - ctx.effect：立即执行（无生命周期管理需求）。
 * 随后把捕获到的 PetMulti 挂到 document.body，宠物即按 DSH 网页版同款逻辑运行
 * （配置/余额/设置/音效全部走本地 HTTP 服务的 /dsh-pet-7340 路由）。
 *
 * 点击穿透：document 上 mousemove + elementFromPoint 命中测试（尊重 pointer-events），
 * 光标在 .dsh-pet-root/.dsh-pet-menu/.dsh-pet-credits/.dsh-pet-apibox 内 → 经 preload
 * 通知主进程关闭穿透（可交互）；否则恢复穿透（点穿到桌面下方应用）。
 */
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { makeFactory } from '../../src/client/app';

// ---------- 假 DSH 模块系统 ----------

/** preload 暴露的桌面桥接口（编译期声明） */
declare global {
  interface Window {
    petDesktop?: { setInteractive: (interactive: boolean) => void };
  }
}

/** require 映射：只提供插件声明的两个宿主模块（其余一律报错暴露问题） */
function requireShim(mod: string): unknown {
  if (mod === 'react') return React;
  if (mod === 'react/jsx-runtime') return jsxRuntime;
  throw new Error('[DeepSeekPet] 独立版不支持模块: ' + mod);
}

/** 捕获 shell.overlay 插槽的渲染函数（设置页 section 不渲染，独立版用汉堡菜单即可） */
interface SlotEntry {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 组件渲染函数返回值是 React 元素树，无静态类型
  render: () => any;
}
const overlayRenderers: SlotEntry[] = [];

/** 假 ctx：结构与 DSH 注入的服务同构，行为做最小适配 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH ctx 为运行时注入的服务集合，无静态类型
const fakeCtx: any = {
  // DSH 的 effect 注册生命周期钩子；独立版无卸载场景，直接执行并返回空清理函数
  effect(fn: () => void | (() => void)): () => void {
    try {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    } catch (e) {
      console.error('[DeepSeekPet] effect 执行失败:', e);
      return () => {};
    }
  },
  // 本地化：register 空实现；bind 返回恒等函数（文案均为中文硬编码）
  locale: {
    register: () => {},
    bind: () => (key: string) => key,
  },
  // 事件流服务缺失：startNotify 内部会检测并跳过（独立版 v1 无系统通知）
  connection: undefined,
  slots: {
    // 捕获插槽渲染函数：记录 name 供后续筛选（overlay 渲染、settings.section 跳过）
    register: (desc: { name?: string }, render: () => unknown) => {
      overlayRenderers.push({ name: desc?.name ?? '', render: render as SlotEntry['render'] });
      return () => {};
    },
    // inject 的 generator 立即全部执行（其内部调用上面的 register）
    inject: (_slot: string, generator: () => Generator) => {
      const g = generator();
      while (!g.next().done) {
        /* 推进 generator 直到 yield 完成 */
      }
    },
  },
};

// ---------- 装配并挂载宠物 ----------

// 与 DSH 一致：makeFactory()(require) 拿到 module，再 apply(ctx) 完成插槽注册
const pluginModule = makeFactory()(requireShim);
pluginModule.apply(fakeCtx);

// 渲染 shell.overlay 条目（宠物浮层）；其余（如 settings.section）独立版不渲染
for (const entry of overlayRenderers) {
  if (entry.name !== 'shell.overlay') continue;
  const mount = document.createElement('div');
  mount.id = 'deepseek-pet-root';
  document.body.appendChild(mount);
  createRoot(mount).render(entry.render());
}

// ---------- 点击穿透切换 ----------

/** 上一次交互状态（避免重复 IPC） */
let lastInteractive = false;

/** 向主进程同步交互状态（true=光标在宠物上，关闭穿透） */
function setInteractive(interactive: boolean): void {
  if (interactive === lastInteractive) return;
  lastInteractive = interactive;
  const bridge = window.petDesktop;
  if (bridge && typeof bridge.setInteractive === 'function') bridge.setInteractive(interactive);
}

// elementFromPoint 尊重 CSS pointer-events：空白处返回 html/body（不命中任何容器）
// → 恢复穿透；宠物本体/菜单/弹窗上返回对应元素 → 关闭穿透
document.addEventListener(
  'mousemove',
  (e) => {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const interactive =
      !!hit && !!hit.closest('.dsh-pet-root, .dsh-pet-menu, .dsh-pet-credits, .dsh-pet-apibox');
    setInteractive(interactive);
  },
  { passive: true },
);
